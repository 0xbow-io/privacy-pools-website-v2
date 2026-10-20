import { describe, it, expect } from 'vitest';
import {
  decodeAbortCode,
  decodeAbortMessage,
  friendlyError,
} from '@/services/sui-witness/abort-codes';

/**
 * Move-abort decoder (audit bug #2 fix).
 *
 * The decoder maps the `const E_* : u64` abort codes declared in
 * ppv2-sui-v2-sync/sources/*.move to names + friendly messages, keyed per module
 * (codes are NOT globally unique).
 *
 * NOTE on the "659" in the prior gap-test: `659` is the SOURCE LINE in
 * pool.move where `assert!(..., E_GVK_MISMATCH)` lives (pool.move:659 in the
 * audit notes) — it is NOT the abort code. The actual abort code for
 * E_GVK_MISMATCH is `69` (pool.move:51, `const E_GVK_MISMATCH: u64 = 69`). We
 * therefore bind the real code 69 here; decoding a literal 659 (an unknown pool
 * code) is also asserted to fail gracefully rather than mislabel.
 */

describe('decodeAbortCode (per-module tables)', () => {
  it('69 -> E_GVK_MISMATCH (pool)', () => {
    const d = decodeAbortCode(69, 'pool');
    expect(d.name).toBe('E_GVK_MISMATCH');
    expect(d.module).toBe('pool');
    expect(d.code).toBe(69);
    expect(d.message).toMatch(/Global View Key/i);
  });

  it('30 -> E_NULLIFIER_ALREADY_SPENT (pool)', () => {
    const d = decodeAbortCode(30, 'pool');
    expect(d.name).toBe('E_NULLIFIER_ALREADY_SPENT');
    expect(d.message).toMatch(/already spent/i);
  });

  it('20 -> E_INVALID_PROOF (pool) — the relayed-withdraw failure mode', () => {
    expect(decodeAbortCode(20, 'pool').name).toBe('E_INVALID_PROOF');
  });

  it('66/67 -> E_INVALID_CIPHERTEXT / E_STATE_TREE_FULL (pool)', () => {
    expect(decodeAbortCode(66, 'pool').name).toBe('E_INVALID_CIPHERTEXT');
    expect(decodeAbortCode(67, 'pool').name).toBe('E_STATE_TREE_FULL');
  });

  it('70 -> E_AUTH_POLICY_ALREADY_SET, 77 -> E_INVALID_LIVENESS (keystore)', () => {
    expect(decodeAbortCode(70, 'keystore').name).toBe('E_AUTH_POLICY_ALREADY_SET');
    expect(decodeAbortCode(77, 'keystore').name).toBe('E_INVALID_LIVENESS');
  });

  it('101 -> E_BELOW_MIN_AMOUNT (entrypoint min-amount)', () => {
    expect(decodeAbortCode(101, 'entrypoint').name).toBe('E_BELOW_MIN_AMOUNT');
  });

  it('43 -> E_ZERO_ROOT (asp_registry)', () => {
    expect(decodeAbortCode(43, 'asp_registry').name).toBe('E_ZERO_ROOT');
  });

  it('codes are NOT global: 32 is E_ZERO_COMMITMENT in BOTH pool and keystore', () => {
    expect(decodeAbortCode(32, 'pool').name).toBe('E_ZERO_COMMITMENT');
    expect(decodeAbortCode(32, 'keystore').name).toBe('E_ZERO_COMMITMENT');
  });

  it('an unknown code in a known module decodes gracefully (no mislabel)', () => {
    // 659 is a line number, NOT a pool abort code -> must NOT be E_GVK_MISMATCH.
    const d = decodeAbortCode(659, 'pool');
    expect(d.name).toBeNull();
    expect(d.message).toMatch(/Unknown pool abort code 659/);
  });

  it('without a module, scans all tables and finds the first match', () => {
    expect(decodeAbortCode(69).name).toBe('E_GVK_MISMATCH'); // pool table first
    expect(decodeAbortCode(200).name).toBe('E_ZERO_WITHDRAWAL'); // relay
  });
});

describe('decodeAbortMessage (full MoveAbort string)', () => {
  const gvkAbort =
    'MoveAbort(MoveLocation { module: ModuleId { address: 0x1edf, name: Identifier("pool") }, function: 12, instruction: 7, function_name: Some("transact_internal") }, 69)';

  it('decodes a full pool MoveAbort with module + code', () => {
    const m = decodeAbortMessage(gvkAbort);
    expect(m).toContain('E_GVK_MISMATCH');
    expect(m).toContain('pool::69');
    expect(m).not.toContain('MoveLocation');
  });

  it('decodes E_NULLIFIER_ALREADY_SPENT (30) from a MoveAbort string', () => {
    const s =
      'MoveAbort(MoveLocation { module: ModuleId { address: 0x1, name: Identifier("pool") } }, 30)';
    expect(decodeAbortMessage(s)).toContain('E_NULLIFIER_ALREADY_SPENT');
  });

  it('decodes a keystore abort (70) using the keystore table, not pool', () => {
    const s =
      'MoveAbort(MoveLocation { module: ModuleId { address: 0x1, name: Identifier("keystore") } }, 70)';
    const m = decodeAbortMessage(s);
    expect(m).toContain('E_AUTH_POLICY_ALREADY_SET');
    expect(m).toContain('keystore::70');
  });

  it('passes a NON-Move error through verbatim', () => {
    const s = 'relayer request failed: network down';
    expect(decodeAbortMessage(s)).toBe(s);
  });
});

describe('friendlyError', () => {
  it('decodes a thrown Error whose message is a MoveAbort', () => {
    const err = new Error(
      'relayer 400: MoveAbort(MoveLocation { name: Identifier("pool") }, 30)',
    );
    expect(friendlyError(err)).toContain('E_NULLIFIER_ALREADY_SPENT');
  });

  it('passes a plain (non-Move) error message through', () => {
    expect(friendlyError(new Error('Sui wallet not connected'))).toBe('Sui wallet not connected');
  });

  it('stringifies a non-Error throw', () => {
    expect(friendlyError('some string')).toBe('some string');
  });
});
