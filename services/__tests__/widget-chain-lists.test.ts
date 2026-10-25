// The action widget's per-flow chain lists for the 2026-10-14 prod chains
// (Mike on #276): every served chain is listed, a swap chain that cannot run
// yet is greyed out with a reason rather than missing.
import { describe, expect, test } from 'bun:test';
import { ENVIRONMENTS } from '../../config/environments';
import { swapDestinationNetworks, swapSourcePoolReason } from '../widget-chain-lists';

const NEW_CHAINS = [10, 8453, 42161, 4663];
const prod = ENVIRONMENTS.prod;
const served = prod.deployments.map((d) => d.chainId);
const name = (id: number) => `chain ${id}`;

describe('widget chain lists', () => {
  test('Shield / Withdraw / Send / Request: every new chain is a served chain with pools', () => {
    for (const id of NEW_CHAINS) {
      expect(served).toContain(id);
      expect(Object.keys(prod.tokensByChain[id] ?? {}).length).toBeGreaterThan(0);
    }
  });

  test('Swap receive: undeliverable served chains are listed greyed out, with a reason', () => {
    const reasons: Record<number, string> = { 10: 'No swaps yet', 4663: 'Swaps cannot land here yet' };
    const list = swapDestinationNetworks([1, 56], served, 1, (id) => reasons[id], name);
    expect(list.map((n) => n.id)).toEqual([1, 56, ...served.filter((id) => id !== 1 && id !== 56)]);
    expect(list.slice(0, 2).every((n) => !n.unavailableReason)).toBe(true);
    for (const id of NEW_CHAINS) {
      const row = list.find((n) => n.id === id);
      expect(row?.unavailableReason).toBeTruthy();
      expect(row?.unavailableReason).not.toContain('—');
    }
    expect(list.find((n) => n.id === 4663)?.unavailableReason).toBe('Swaps cannot land here yet');
    expect(list.find((n) => n.id === 8453)?.unavailableReason).toBe('No swap route yet');
  });

  test('Swap receive: the source chain with nothing to receive says so', () => {
    const list = swapDestinationNetworks([56], [1, 56], 1, () => undefined, name);
    expect(list).toEqual([{ id: 56, name: 'chain 56' }, { id: 1, name: 'chain 1', unavailableReason: 'Nothing to receive here' }]);
  });

  test('Swap from pool: a pool swaps cannot run from keeps a reason', () => {
    expect(swapSourcePoolReason(true, undefined)).toBeUndefined();
    expect(swapSourcePoolReason(false, 'No swaps yet')).toBe('No swaps yet');
    expect(swapSourcePoolReason(false, undefined)).toBe('Not swappable yet');
  });

  test('swaps run on Optimism, Base and Arbitrum; Robinhood has no RelaySwaps (greyed out)', () => {
    for (const id of [10, 8453, 42161]) {
      expect(prod.deploymentsByChain[id]?.relaySwaps).toBeDefined();
      expect(prod.swapOutputTokens[id]?.length).toBeGreaterThan(0);
    }
    expect(prod.deploymentsByChain[4663]?.relaySwaps).toBeUndefined();
    expect(prod.swapOutputTokens[4663]).toBeUndefined();
  });
});
