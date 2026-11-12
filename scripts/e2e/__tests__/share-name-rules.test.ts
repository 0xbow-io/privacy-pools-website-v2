import { describe, expect, test } from 'bun:test';

import { findShareNames } from '../share-name-rules';

// Built, not spelled: the symbols are never written out in this repo.
const pp = (sym: string) => `pp${sym}`;
const names = (text: string) => findShareNames(text).map((h) => h.match.toLowerCase());

describe('share-name guard rules', () => {
  test('every share token symbol is caught, any case, as a whole word', () => {
    for (const sym of ['ETH', 'USDC', 'USDT', 'BNB']) {
      expect(names(`You hold 1.5 ${pp(sym)}`)).toEqual([pp(sym).toLowerCase()]);
      expect(names(`balance: 2 ${pp(sym).toUpperCase()}.`)).toHaveLength(1);
    }
    expect(names('ETH USDC USDT BNB')).toEqual([]);
    expect(names('appETHx')).toEqual([]);
  });

  test('a raw count under a coin label is caught (DEV-621)', () => {
    // The old fallback: the count, marked "≈", under the coin's name.
    expect(names('Shielded ≈ 4.94 USDT')).toEqual(['≈ 4.94 usdt']);
    expect(names('≈ 0.09989 ETH pending')).toHaveLength(1);
    expect(names('need ≈1,234.5 USDC')).toHaveLength(1);
    // A stablecoin figure with more than two decimals: a count or a raw value.
    expect(names('Received 4.918123 USDT')).toEqual(['4.918123 usdt']);
    expect(names('1,250.505 USDC')).toHaveLength(1);
    // What the screen shows now passes: the converted figure, an estimate, a dollar figure.
    for (const ok of ['4.97 USDT', '~4.97 USDT', '≈ $4.97', '0.00412 ETH', '1 ETH = 2,512.12 USDC', '<0.01 USDC', '… USDT']) {
      expect(names(ok)).toEqual([]);
    }
  });

  test('a dollar figure has exactly two decimals (DEV-621)', () => {
    for (const bad of ['worth $4.9 today', '$4.9694', '$1,234.5']) {
      expect(names(bad)).toHaveLength(1);
    }
    // Whole-dollar presets and the pool page's "$0" placeholder are not judged here.
    for (const whole of ['Presets $10 $25 $100', 'Pool TVL $0']) expect(names(whole)).toEqual([]);
    for (const ok of ['$4.97', '$5.00', '$1,234.56', '<$0.01', '≈ $4.97', '~$4.97', '$10.82k', '$10k', '$1.5M', '$2B', '-$4.97', 'Up $0.12 today', '$4.97.']) {
      expect(names(ok)).toEqual([]);
    }
  });

  test('the accessibility label on a balance hint', () => {
    // The (i) beside a yield balance is "Balance details"; the pool unit's noun never leads it.
    expect(names('Balance details')).toEqual([]);
    expect(names('Share balance details')).toEqual(['share']);
  });

  test('the noun is caught', () => {
    expect(names('Your shares were not unwrapped.')).toEqual(['shares']);
    expect(names('Pick a pool share, or use Withdraw.')).toEqual(['share']);
    expect(names('The share amount must be positive.')).toEqual(['share']);
    expect(names('1 share = 1.02 USDC')).toEqual(['share']);
    expect(names('Rate per share: 1.02')).toEqual(['share']);
    expect(names('share count unavailable')).toEqual(['share']);
    expect(names('SHARES')).toEqual(['shares']);
  });

  test('the verb is not: sharing a link is not a share name', () => {
    for (const copy of [
      'Share',
      'Share this request. The payer fulfills it with a private transfer.',
      'Share a link, get paid privately.',
      'Never share this code.',
      'Use the link below to share.',
      'Share with your accountant',
      'you share a receipt link with them afterwards',
      'the selected groups share one on-chain transaction',
      'Choose what to share in the demo',
      'Failed to share backup.',
    ]) expect(names(copy)).toEqual([]);
  });

  test('a hit carries the text around it', () => {
    const [hit] = findShareNames(`Withdraw all of it: 12.5 ${pp('USDC')} available now`);
    expect(hit!.snippet).toContain(`12.5 ${pp('USDC')} available`);
  });

  test('it runs from its own source, as the page runs it', () => {
    // The guard ships Function.prototype.toString() into the browser.
    const rebuilt = new Function(`return (${findShareNames.toString()})`)() as typeof findShareNames;
    expect(rebuilt(`3 ${pp('USDT')}`).map((h) => h.match)).toEqual([pp('USDT')]);
    expect(rebuilt('Share a link')).toEqual([]);
  });
});
