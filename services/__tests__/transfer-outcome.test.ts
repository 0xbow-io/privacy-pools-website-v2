import { describe, expect, test } from 'bun:test';
import {
  isConfirmedRevert,
  isIndeterminateOutcome,
  isKnownRejection,
  isRelayerRefusal,
  timedOutRelayTxHash,
  isRelayerOutOfGas,
  isRelayerUnreachable,
  nameRelayerTransportFailure,
  relayerOutOfGasMessage,
  isRelayWaitTimeout,
  isRelayerNullifierInFlight,
} from '../transfer-outcome';
import { RelayedReceiptTimeout } from '../relayed-receipt';

// The message the relayer actually returned, verbatim from the 400 body that
// caused the bug (Artem, OP mainnet, 2026-08-20).
const RELAYER_400 = 'PoolVault transact failed: The contract function "transact" reverted. (PoolVault_ProofContextMismatch).';

describe('transfer failure classification', () => {
  test('the relayer refusing to submit is a KNOWN non-send, not an unknown outcome', () => {
    expect(isRelayerRefusal(RELAYER_400)).toBe(true);
    // Even though the transfer was handed to the relayer, so broadcastAttempted
    // is true — that flag is set before the call and cannot see the refusal.
    expect(isIndeterminateOutcome(RELAYER_400, true)).toBe(false);
  });

  test('other pool reverts the relayer reports are refusals too', () => {
    expect(isRelayerRefusal('PoolVault transact failed: ... (PoolVault_InvalidASPRoot).')).toBe(true);
    expect(isRelayerRefusal('The contract function "transact" reverted.')).toBe(true);
  });

  test('a transaction that landed and then reverted is NOT a relayer refusal', () => {
    const onChain = 'The transfer reverted on-chain. Tx: 0xabc';
    expect(isConfirmedRevert(onChain)).toBe(true);
    expect(isRelayerRefusal(onChain)).toBe(false);
    expect(isIndeterminateOutcome(onChain, true)).toBe(false);
  });

  test('pre-broadcast SDK and guard throws stay known rejections', () => {
    // The 2026-08-17 regression: these once produced a success screen with a
    // dead receipt.
    for (const message of [
      'Insufficient value for transact: available=0.001, requested=0.001493',
      'FeeCommitmentExpired',
      'User rejected the request',
      'Superseded by a newer run',
      'The amount exceeds your available balance',
    ]) {
      expect(isKnownRejection(message)).toBe(true);
      expect(isIndeterminateOutcome(message, true)).toBe(false);
    }
  });

  test('a genuinely unclear failure after handover stays unknown, so the receipt survives', () => {
    const vague = 'network error: socket hang up';
    expect(isKnownRejection(vague)).toBe(false);
    expect(isRelayerRefusal(vague)).toBe(false);
    expect(isIndeterminateOutcome(vague, true)).toBe(true);
  });

  test('nothing is indeterminate before the transfer was handed over', () => {
    expect(isIndeterminateOutcome('network error: socket hang up', false)).toBe(false);
  });
});

// DEV-370, Mike's report: with the relayer down, a flow that did not even need
// a relayer reported "Transfer failed: All configured relayers failed to quote:
// 0xbow Relayer: Failed to fetch". An outage in an optional dependency must not
// read as the transfer itself having failed.
describe('relayer unreachable (a quote failure, not a refusal)', () => {
  const QUOTE_DOWN = 'All configured relayers failed to quote: 0xbow Relayer: Failed to fetch';

  test('the message from the report is recognised', () => {
    expect(isRelayerUnreachable(QUOTE_DOWN)).toBe(true);
  });

  test('a bare transport failure from the QUOTE hook is renamed so the outage copy engages', () => {
    // These are the exact strings a blocked relayer host produced in the
    // browser (Pack L-a e2e, 2026-08-27). The classifier stays narrow (an RPC
    // "network error" elsewhere must not be blamed on the relayer); the quote
    // hook, where the failing call IS the relayer, does the naming.
    for (const raw of ['Failed to fetch', 'TypeError: Load failed', 'Network request failed', 'connect ECONNREFUSED 10.0.0.1:443']) {
      const named = nameRelayerTransportFailure(new Error(raw));
      expect(named.message).toContain(raw);
      expect(isRelayerUnreachable(named.message)).toBe(true);
    }
    // A refusal or a revert passes through untouched: those are not outages.
    expect(nameRelayerTransportFailure(new Error(RELAYER_400)).message).toBe(RELAYER_400);
    expect(isRelayerUnreachable(nameRelayerTransportFailure(new Error(RELAYER_400)).message)).toBe(false);
  });

  test('a REFUSAL is not an outage — the relayer answered and declined', () => {
    // Both must not claim the same failure: one says "retry, or send it
    // yourself", the other says "the pool rejected this proof".
    expect(isRelayerUnreachable(RELAYER_400)).toBe(false);
    expect(isRelayerRefusal(RELAYER_400)).toBe(true);
  });

  test('a landed-then-reverted transaction is neither', () => {
    const onChain = 'The transfer reverted on-chain. Tx: 0xabc';
    expect(isRelayerUnreachable(onChain)).toBe(false);
    expect(isRelayerRefusal(onChain)).toBe(false);
  });

  test('an unrelated failure is not blamed on the relayer', () => {
    for (const message of [
      'User rejected the request',
      'The amount exceeds your available balance',
      'network error: socket hang up',
    ]) {
      expect(isRelayerUnreachable(message)).toBe(false);
    }
  });
});

describe('relayer out of gas (DEV-400): the relayer answered, could not pay, nothing was sent', () => {
  // Verbatim from the 400 body Zeeshan hit on BNB mainnet (QA I-d).
  const BNB_400 = 'HTTP 400: {"message":"Relay failed: The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account..","error":"Bad Request","statusCode":400}';
  test('classifies the node\'s insufficient-balance rejection', () => {
    expect(isRelayerOutOfGas(BNB_400)).toBe(true);
    expect(isRelayerOutOfGas('Relay failed: insufficient funds for gas * price + value')).toBe(true);
    expect(isRelayerOutOfGas('PoolVault transact failed: The contract function "transact" reverted. (PoolVault_ProofContextMismatch).')).toBe(false);
    expect(isRelayerOutOfGas('The transfer reverted on-chain. Tx: 0xabc')).toBe(false);
    expect(isRelayerOutOfGas('All configured relayers failed to quote: 0xbow Relayer: Failed to fetch')).toBe(false);
    // The user's own wallet refusing to pay for gas is not a relayer outage.
    expect(isRelayerOutOfGas('insufficient funds for gas * price + value: have 0 want 21000')).toBe(false);
    expect(isRelayerOutOfGas('TransactionExecutionError: The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.')).toBe(false);
    // A simulated revert that mentions a balance is a refusal, not gas exhaustion.
    expect(isRelayerOutOfGas('Relay failed: The contract function "transact" reverted. (InsufficientBalance)')).toBe(false);
  });
  test('classifies the relayer\'s 503 for its own wallet, on every flow', () => {
    for (const action of ['Relay', 'PoolVault transact', 'RelaySwaps']) {
      expect(isRelayerOutOfGas(`HTTP 503: {"message":"Relayer temporarily unavailable on chain 1: the relayer's wallet cannot cover gas for ${action}. This is a relayer-side fault, not a problem with your request — retry after the relayer wallet is topped up.","error":"Service Unavailable","statusCode":503}`)).toBe(true);
    }
    expect(isRelayerOutOfGas('HTTP 503: {"message":"Quote deadline exceeded","statusCode":503}')).toBe(false);
  });
  test('the copy names the relayer and states the balance is unchanged', () => {
    const msg = relayerOutOfGasMessage('withdrawal');
    expect(msg).toContain('relayer cannot pay for gas');
    expect(msg).toContain('this withdrawal was not sent');
    expect(msg).not.toMatch(/statusCode|HTTP 400|\{/);
  });
});

describe('timedOutRelayTxHash', () => {
  const HASH = '0x1887f5bee7f619944933ac5091ea24d9baf577f986f3a00d887ec3ee00000000';
  test('extracts the hash from viem\'s receipt timeout, with or without quotes and the SDK prefix', () => {
    expect(timedOutRelayTxHash(`Wait for receipt failed: Timed out while waiting for transaction with hash "${HASH}" to be confirmed.\n\nVersion: viem@2.45.3`)).toBe(HASH);
    expect(timedOutRelayTxHash(`Timed out while waiting for transaction with hash ${HASH} to be confirmed.`)).toBe(HASH);
  });
  test('anything else is not a timeout', () => {
    expect(timedOutRelayTxHash('Withdrawal transaction reverted on-chain.')).toBeNull();
    expect(timedOutRelayTxHash('Timed out while waiting for transaction with hash 0x1234 to be confirmed.')).toBeNull();
    expect(timedOutRelayTxHash(null)).toBeNull();
  });
});

describe('relay still pending (DEV-458)', () => {
  test('our own receipt-wait timeout and viem\'s are both a pending relay, not a failure', () => {
    expect(isRelayWaitTimeout(new RelayedReceiptTimeout().message)).toBe(true);
    expect(isRelayWaitTimeout(`Timed out while waiting for transaction with hash "0x${'ab'.repeat(32)}" to be confirmed.`)).toBe(true);
    expect(isRelayWaitTimeout('PoolVault transact failed: reverted')).toBe(false);
    expect(isRelayWaitTimeout(null)).toBe(false);
  });

  test('the relayer\'s in-flight refusal is recognised and is not a contract refusal', () => {
    const msg = `HTTP 400: Nullifier 0x${'12'.repeat(32)} is already in-flight — a transaction spending this note is pending confirmation. Wait for it to settle and retry.`;
    expect(isRelayerNullifierInFlight(msg)).toBe(true);
    expect(isRelayerRefusal(msg)).toBe(false);
  });
});
