import { describe, expect, test } from 'bun:test';
import { ROW_ACTION_SWITCH_WINDOW_MS, pendingRowActionStep } from '../row-chain-action';

const pending = { kind: 'withdraw', chainId: 56, at: 1_000 };
const settled = { sdkSessionChainId: null, sdkInitializing: false };
const on = (selectedChainId: number, sessionChainId: number, sdk: { sdkSessionChainId: number | null; sdkInitializing: boolean; sdkResuming?: boolean } = settled) =>
  ({ selectedChainId, sessionChainId, ...sdk });

describe('row action on its own chain', () => {
  test('waits until the selection AND the session are on the row chain', () => {
    expect(pendingRowActionStep(pending, on(1, 1), 1_100)).toBe('wait');
    // The selection committed but the wallet session has not followed yet.
    expect(pendingRowActionStep(pending, on(56, 1), 1_100)).toBe('wait');
    expect(pendingRowActionStep(pending, on(1, 56), 1_100)).toBe('wait');
    expect(pendingRowActionStep(pending, on(56, 56), 1_100)).toBe('open');
  });

  test("waits while the SDK still holds the previous chain's session or is building one", () => {
    // The render that carries the new chain, before the SDK's teardown ran.
    expect(pendingRowActionStep(pending, on(56, 56, { sdkSessionChainId: 1, sdkInitializing: false }), 1_100)).toBe('wait');
    // Torn down, the next session being built.
    expect(pendingRowActionStep(pending, on(56, 56, { sdkSessionChainId: null, sdkInitializing: true }), 1_100)).toBe('wait');
    // Built for the row's chain, or none to build (keys not derived yet).
    expect(pendingRowActionStep(pending, on(56, 56, { sdkSessionChainId: 56, sdkInitializing: false }), 1_100)).toBe('open');
    expect(pendingRowActionStep(pending, on(56, 56, settled), 1_100)).toBe('open');
  });

  test('waits through the gap before a promptless rebuild, so it never opens into the sign-in dialog', () => {
    // Keys were unlocked on the old chain. After its teardown there is no
    // session and none building yet, but one is about to be rebuilt silently.
    expect(pendingRowActionStep(pending, on(56, 56, { sdkSessionChainId: null, sdkInitializing: false, sdkResuming: true }), 1_100)).toBe('wait');
    expect(pendingRowActionStep(pending, on(56, 56, { sdkSessionChainId: null, sdkInitializing: true }), 1_100)).toBe('wait');
    expect(pendingRowActionStep(pending, on(56, 56, { sdkSessionChainId: 56, sdkInitializing: false }), 1_100)).toBe('open');
  });

  test('a switch that never settles lapses instead of opening much later', () => {
    expect(pendingRowActionStep(pending, on(56, 56), 1_000 + ROW_ACTION_SWITCH_WINDOW_MS)).toBe('open');
    expect(pendingRowActionStep(pending, on(56, 56), 1_000 + ROW_ACTION_SWITCH_WINDOW_MS + 1)).toBe('drop');
    expect(pendingRowActionStep(pending, on(56, 56, { sdkSessionChainId: 1, sdkInitializing: false }), 1_000 + ROW_ACTION_SWITCH_WINDOW_MS + 1)).toBe('drop');
  });

  test('nothing pending is nothing to do', () => {
    expect(pendingRowActionStep(null, on(56, 56), 0)).toBe('none');
  });
});
