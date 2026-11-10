// QA on #29: on Robinhood Chain, Send's pool picker set to "USDT on Ethereum"
// switched the form correctly, then toasted "USDT is not available on this
// network. Pick a token manually." The picker re-opened Send through an opener
// built for the chain being left, which checked the pick against that chain.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { pendingPoolReopenStep, type PendingPoolReopen } from '@/services/pool-pick-reopen';

const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const ROBINHOOD = 46630;
const ETHEREUM = 1;
// The registry as the transfer opener reads it: USDT has no pool on Robinhood Chain.
const POOLS: Record<number, string[]> = { [ROBINHOOD]: ['ETH'], [ETHEREUM]: ['ETH', 'USDT'] };
// openTransferModal's prefill check, closed over the chain of the render that built it.
const transferOpener = (chainId: number, errors: string[]) => (symbol: string) => {
  if (!POOLS[chainId].includes(symbol)) errors.push('USDT is not available on this network. Pick a token manually.');
};

describe('a pool picked on another chain', () => {
  const pick: PendingPoolReopen = { fromChainId: ROBINHOOD, chainId: ETHEREUM, mode: 'send', symbol: 'USDT' };

  test('the old flow: the opener held by the picker checks the pick against the chain being left', () => {
    const errors: string[] = [];
    transferOpener(ROBINHOOD, errors)(pick.symbol);
    expect(errors).toHaveLength(1);
  });

  test('the re-open waits for a render on the new chain, then opens with a current opener and no error', () => {
    const errors: string[] = [];
    let pending: PendingPoolReopen | null = pick;
    // The render right after the switch may still carry the old chain.
    for (const chainId of [ROBINHOOD, ETHEREUM]) {
      const step = pendingPoolReopenStep(pending, chainId);
      if (step === 'wait') continue;
      if (step === 'open' && pending) transferOpener(chainId, errors)(pending.symbol);
      pending = null;
    }
    expect(errors).toEqual([]);
    expect(pending).toBeNull();
  });

  test('a chain that moved elsewhere drops the pick, nothing pending is ever re-opened', () => {
    expect(pendingPoolReopenStep(null, ETHEREUM)).toBe('none');
    expect(pendingPoolReopenStep(pick, ROBINHOOD)).toBe('wait');
    expect(pendingPoolReopenStep(pick, ETHEREUM)).toBe('open');
    expect(pendingPoolReopenStep(pick, 8453)).toBe('drop');
  });

  test('the hub picker never calls an opener after awaiting the chain switch', () => {
    const hub = read('components/home/action-hub.tsx');
    const start = hub.indexOf('const publishPoolSheet = useCallback(');
    const handler = hub.slice(start, hub.indexOf('onSelectNetwork:', start));
    const afterSwitch = handler.slice(handler.indexOf('await selectChain(targetChain)'));
    expect(afterSwitch).not.toContain('openTransferModal(');
    expect(afterSwitch).not.toContain('openWithdrawModal(');
    expect(afterSwitch).toContain('setPendingPoolReopen({ fromChainId: chainId, chainId: targetChain');
    expect(hub).toContain('pendingPoolReopenStep(pendingPoolReopen, chainId)');
  });
});
