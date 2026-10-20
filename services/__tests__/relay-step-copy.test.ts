import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CLAIM_FEE_EXCEEDS_PAYMENT,
  claimRelayFailureText,
  isClaimRelayMethod,
  quoteWithFreshRetry,
} from '../relay-step-copy';
import { RelayedReceiptTimeout, onRelayCalled, recordRelayedHashes } from '../relayed-receipt';

function rejected(message: string): Error {
  const err = new Error(message);
  err.name = 'RelayerRejected';
  return err;
}

describe('claimRelayFailureText (DEV-494)', () => {
  test('a relay the relayer took but that never landed never says nothing was spent', () => {
    for (const err of [new RelayedReceiptTimeout(), new Error('Relayed transaction was not observed in any block within the wait budget')]) {
      const text = claimRelayFailureText(err)!;
      expect(text).toContain('has not landed yet');
      expect(text).toContain('check your balance');
      expect(text).not.toMatch(/nothing was (spent|sent)/i);
    }
  });

  test('a refusal the relayer gives before it signs says nothing was spent', () => {
    for (const message of [
      'HTTP 400: {"message":"Relay failed: The contract function \\"relay\\" reverted (PoolVault_InvalidProof).","statusCode":400}',
      'HTTP 400: {"message":"Fee commitment has expired","statusCode":400}',
    ]) {
      expect(claimRelayFailureText(rejected(message))).toContain('nothing was spent');
    }
  });

  test('a 400 that can follow a broadcast keeps its own wording', () => {
    for (const message of [
      'HTTP 400: {"message":"Relay failed: The contract call \\"relay\\" failed: timed out.","statusCode":400}',
      'HTTP 400: {"message":"Relay failed: nonce too low","statusCode":400}',
    ]) {
      expect(claimRelayFailureText(rejected(message))).toBeNull();
    }
    // Not from the relayer interactor at all, or a transport failure.
    expect(claimRelayFailureText(new Error('Failed to fetch'))).toBeNull();
    expect(claimRelayFailureText(new Error('HTTP 400: {"message":"Fee commitment has expired"}'))).toBeNull();
  });

  test('the relayer unable to pay gas, or throttling, is named and not sent', () => {
    const gas = claimRelayFailureText(rejected('HTTP 503: {"message":"Relayer temporarily unavailable on chain 1: the relayer\'s wallet cannot cover gas for Relay."}'))!;
    expect(gas).toContain('relayer cannot pay for gas');
    expect(gas).toContain('nothing was spent');
    expect(claimRelayFailureText(rejected('HTTP 429: {"message":"ThrottlerException: Too Many Requests"}'))).toContain('busy');
    // A 429 that is not the relayer interactor's answer proves nothing.
    expect(claimRelayFailureText(new Error('HTTP 429: Too Many Requests'))).toBeNull();
  });

  test('no em dash in any of it', () => {
    expect(CLAIM_FEE_EXCEEDS_PAYMENT).not.toContain('—');
    expect(CLAIM_FEE_EXCEEDS_PAYMENT).toContain('Nothing was sent.');
    expect(claimRelayFailureText(new RelayedReceiptTimeout())).not.toContain('—');
  });

  test('only the claim relay methods drive the claim labels', () => {
    expect(isClaimRelayMethod('relayWithdrawal')).toBe(true);
    expect(isClaimRelayMethod('relayRegisterAndWithdrawal')).toBe(true);
    expect(isClaimRelayMethod('relayTransfer')).toBe(false);
    expect(isClaimRelayMethod(null)).toBe(false);
  });
});

describe('quoteWithFreshRetry (DEV-494)', () => {
  const tooSmall = new Error('Relay fee (5100000000000000000) exceeds withdrawal amount (5000000000000000000).');
  const isTooSmall = (err: unknown) => err === tooSmall;

  test('one refusal at a busy block is not the answer: a fresh quote decides', async () => {
    let calls = 0;
    const slept: number[] = [];
    const q = await quoteWithFreshRetry({
      quote: async () => { calls += 1; if (calls === 1) throw tooSmall; return 'ok'; },
      isTooSmall,
      sleep: async (ms) => { slept.push(ms); },
    });
    expect(q).toBe('ok');
    expect(calls).toBe(2);
    expect(slept).toEqual([4_000]);
  });

  test('two refusals refuse; any other error is not retried', async () => {
    let calls = 0;
    await expect(quoteWithFreshRetry({ quote: async () => { calls += 1; throw tooSmall; }, isTooSmall, sleep: async () => {} })).rejects.toBe(tooSmall);
    expect(calls).toBe(2);
    const outage = new Error('Failed to fetch');
    calls = 0;
    await expect(quoteWithFreshRetry({ quote: async () => { calls += 1; throw outage; }, isTooSmall, sleep: async () => {} })).rejects.toBe(outage);
    expect(calls).toBe(1);
  });
});

describe('onRelayCalled (DEV-494)', () => {
  test('announces the relay method when the request leaves, before its answer', async () => {
    const order: string[] = [];
    const off = onRelayCalled((m) => order.push(`start:${m}`));
    const relayer = recordRelayedHashes({
      relayWithdrawal: async () => { order.push('http'); return { txHash: '0x' + 'ab'.repeat(32) }; },
      getWithdrawalQuote: async () => ({ feeAmount: '1' }),
    });
    await relayer.getWithdrawalQuote();
    await relayer.relayWithdrawal();
    off();
    await relayer.relayWithdrawal();
    expect(order).toEqual(['start:relayWithdrawal', 'http', 'http']);
  });
});

describe('the claim and the send wire the labels (DEV-494)', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  test('the claim hears the post and the hash, and classifies its failure', () => {
    const src = read('../../hooks/use-note-import.ts');
    const start = src.indexOf('onRelayCalled((method) => {');
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(src.indexOf('await session.registerAndWithdraw('));
    expect(src).toContain('stopHearingStart();');
    expect(src).toContain('stopHearingHash();');
    // Scoped to the relayed claim call, not the whole on-chain import.
    const call = src.indexOf('await session.registerAndWithdraw(');
    const classify = src.indexOf('const text = claimRelayFailureText(relayErr);');
    expect(classify).toBeGreaterThan(call);
    expect(classify - call).toBeLessThan(800);
    expect(src).not.toContain('claimRelayFailureText(e)');
    expect(src).toContain('quoteWithFreshRetry({');
  });

  test('a send whose receipt is in hand does not wait the full bulk budget', () => {
    const src = read('../../components/transfer-modal-provider.tsx');
    expect(src).toContain("...(sdkReceiptStatus === true ? { attempts: 4, intervalMs: 3_000, budgetMs: 20_000 } : {}),");
    expect(src).toContain('setLoadingMessage(RELAY_WAITING_BLOCK);');
    expect(src).toContain('if (live()) setLoadingMessage(RELAY_WAITING_RELAYER);');
  });
});
