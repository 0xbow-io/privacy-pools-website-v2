import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isUnknownKeystoreRoot, keystoreRootRefreshingMessage } from '../keystore-root-error';
import { isConfirmedRevert, isKnownRejection, isRelayerOutOfGas, isRelayerRefusal } from '../transfer-outcome';

// The incident's relayer answer, as the user's client saw it.
const INCIDENT = 'HTTP 400 {"message":"PPRouter withdrawToUnderlying failed: The contract function '
  + '"withdrawToUnderlying" reverted with the following reason: execution reverted (PoolVault_UnknownKeystoreRoot)",'
  + '"error":"Bad Request","statusCode":400}';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
const code = (file: string) => readFileSync(join(ROOT, file), 'utf8');

describe('the incident string reaches the refreshing message on every path', () => {
  test('it is the relayer-refusal shape and nothing earlier claims it', () => {
    expect(isUnknownKeystoreRoot(INCIDENT)).toBe(true);
    // The transfer path sends it to its relayer-refusal branch (the raw-error text lives there).
    expect(isRelayerRefusal(INCIDENT)).toBe(true);
    expect(isKnownRejection(INCIDENT)).toBe(false);
    expect(isConfirmedRevert(INCIDENT)).toBe(false);
    expect(isRelayerOutOfGas(INCIDENT)).toBe(false);
  });

  test('transfer: the UnknownKeystoreRoot check is INSIDE the relayer-refusal branch, with its cleanup and return', () => {
    const src = code('components/transfer-modal-provider.tsx');
    const start = src.indexOf('if (relayerRefused) {');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('return;', start);
    const branch = src.slice(start, end);
    expect(branch).toContain("setStep('review')");
    expect(branch).toContain("isUnknownKeystoreRoot(message)");
    expect(branch).toContain("keystoreRootRefreshingMessage('transfer')");
    // The raw contract error stays only as the other arm of the same branch.
    expect(branch.indexOf('keystoreRootRefreshingMessage')).toBeLessThan(branch.indexOf('The relayer would not submit'));
  });

  test('withdrawal: the check runs before the generic "Withdrawal failed" arm and the relayer-refusal copy', () => {
    const src = code('components/withdraw-modal-provider.tsx');
    const catchAt = src.indexOf("log('error', 'Withdraw', `Withdrawal failed: ${message}`)");
    const tail = src.slice(catchAt, catchAt + 1200);
    expect(tail.indexOf("keystoreRootRefreshingMessage('withdrawal')")).toBeGreaterThan(-1);
    expect(tail.indexOf("keystoreRootRefreshingMessage('withdrawal')")).toBeLessThan(tail.indexOf('Withdrawal failed: ${shownError(err)}'));
    // The relay wrapper rethrows the relayer's error untouched, so the final catch sees the incident string.
    expect(src).toContain('if (!timedOutHash) throw relayErr;');
  });

  test('exit: the check runs before the generic "Ragequit failed" message and after only the wallet-rejection arm', () => {
    const src = code('components/ragequit-modal-provider.tsx');
    const at = src.indexOf("keystoreRootRefreshingMessage('exit')");
    expect(at).toBeGreaterThan(-1);
    const rejection = src.indexOf("message.includes('User rejected')");
    expect(rejection).toBeLessThan(at);
    expect(INCIDENT).not.toMatch(/Superseded|User rejected|User denied|User cancelled/);
  });

  test('each flow shows the refreshing message and never the raw dump', () => {
    for (const flow of ['withdrawal', 'exit', 'transfer'] as const) {
      const text = keystoreRootRefreshingMessage(flow);
      expect(text).toContain('refreshing');
      expect(text).not.toContain('400');
      expect(text).not.toContain('PoolVault');
    }
  });
});
