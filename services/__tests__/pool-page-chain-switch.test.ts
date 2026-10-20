import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { mustLeavePoolPageToSwitch } from '@/services/pool-page-chain-switch';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');

describe('mustLeavePoolPageToSwitch (DEV-453)', () => {
  const base = { targetChainId: 4114, targetChainType: 'evm', currentChainId: 56, pathname: '/chains/bsc/bnb' };
  test('another EVM chain from a pool page leaves it first', () => {
    expect(mustLeavePoolPageToSwitch(base)).toBe(true);
  });
  test('the same chain, a non-EVM chain, or off a pool page does not', () => {
    expect(mustLeavePoolPageToSwitch({ ...base, targetChainId: 56 })).toBe(false);
    expect(mustLeavePoolPageToSwitch({ ...base, targetChainType: 'sui' })).toBe(false);
    expect(mustLeavePoolPageToSwitch({ ...base, pathname: '/' })).toBe(false);
  });

  test('the pool card compares against the POOL\'s chain, not the app\'s active chain', () => {
    const page = readFileSync(join(ROOT, 'components/pools/pool-page-content.tsx'), 'utf8');
    expect(page).toContain('currentChainId: poolChainId');
  });

  test('both chain selectors go through it, and the pool card goes home before switching', () => {
    const header = readFileSync(join(ROOT, 'components/ui/header.tsx'), 'utf8');
    expect(header).toContain('mustLeavePoolPageToSwitch(');
    const page = readFileSync(join(ROOT, 'components/pools/pool-page-content.tsx'), 'utf8');
    const start = page.indexOf('const handleChainSelect');
    const body = page.slice(start, page.indexOf('\n  };', start));
    const guard = body.indexOf('mustLeavePoolPageToSwitch(');
    expect(guard).toBeGreaterThan(-1);
    expect(body.indexOf("router.replace('/')", guard)).toBeGreaterThan(guard);
    // The in-place wallet switch only runs after the guard returned. Both
    // markers must exist, or a missing return would compare against -1.
    const guardReturn = body.indexOf('return;', guard);
    expect(guardReturn).toBeGreaterThan(guard);
    expect(body.indexOf('switchChain(')).toBeGreaterThan(guardReturn);
  });
});
