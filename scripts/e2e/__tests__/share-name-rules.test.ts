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
