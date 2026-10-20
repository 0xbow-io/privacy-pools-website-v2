import { describe, expect, test } from 'bun:test';
import {
  registerSwapHandoff,
  registerSwapTabHandoff,
  requestSwap,
  requestSwapTab,
} from '../swap-handoff';

const unsubscribes: Array<() => void> = [];
/** Module-level slots persist across tests: clear ours before each one. */
function fresh() {
  while (unsubscribes.length) unsubscribes.pop()!();
}

describe('swap handoff routing', () => {
  test('nobody mounted: the request is dropped, not swallowed', () => {
    fresh();
    expect(requestSwap({ tokenSymbol: 'ETH' })).toBe(false);
    expect(requestSwapTab({ tokenSymbol: 'ETH' })).toBe(false);
  });

  test('the swap modal takes a request when mounted, mode included', () => {
    fresh();
    let got: unknown = null;
    unsubscribes.push(registerSwapHandoff((req) => { got = req; return true; }));
    expect(requestSwap({ tokenSymbol: 'USDC', destinationChainId: 1, mode: 'reshield' })).toBe(true);
    expect(got).toEqual({ tokenSymbol: 'USDC', destinationChainId: 1, mode: 'reshield' });
  });

  test('a refusing modal is reported as a refusal', () => {
    fresh();
    unsubscribes.push(registerSwapHandoff(() => false));
    expect(requestSwap({ outputTokenAddress: '0x0000000000000000000000000000000000000001' })).toBe(false);
  });

  test('unsubscribe only clears its own registration', () => {
    fresh();
    const first = registerSwapTabHandoff(() => false);
    const second = registerSwapTabHandoff(() => true);
    unsubscribes.push(second);
    first(); // stale unmount must not wipe the live registration
    expect(requestSwapTab({})).toBe(true);
  });

  test('swap tab handoff carries the pair and the destination (private reshield to self)', () => {
    fresh();
    let got: unknown = null;
    unsubscribes.push(registerSwapTabHandoff((req) => { got = req; return true; }));
    const req = { tokenSymbol: 'USDC', initialAmount: '5', outputTokenAddress: '0xabc', destinationChainId: 1 };
    expect(requestSwapTab(req)).toBe(true);
    expect(got).toEqual(req);
  });
});
