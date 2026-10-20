import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { rowStatus } from '../registration-rows';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');

/**
 * DEV-440: closing the registration modal mid-way let both transactions land,
 * and the landed run wrote 'complete' to the receive-setup store, but the
 * card's row kept its cached "Not registered" until a reload.
 */
describe('rowStatus', () => {
  test('a stored registration further along than the cached read wins', () => {
    expect(rowStatus('unregistered', 'compatible')).toBe('compatible');
    expect(rowStatus('unknown', 'compatible')).toBe('compatible');
    expect(rowStatus('unregistered', 'partial')).toBe('partial');
    expect(rowStatus('partial', 'compatible')).toBe('compatible');
  });
  test('a stored answer never moves a row backwards', () => {
    expect(rowStatus('compatible', 'unregistered')).toBe('compatible');
    expect(rowStatus('partial', 'unregistered')).toBe('partial');
  });
  test('incompatible is a different unlock, not progress', () => {
    expect(rowStatus('incompatible', 'compatible')).toBe('incompatible');
    expect(rowStatus('unregistered', 'incompatible')).toBe('unregistered');
  });
  test('an unread row stays unread, and nothing stored changes nothing', () => {
    expect(rowStatus(undefined, 'compatible')).toBeUndefined();
    expect(rowStatus('unregistered', null)).toBe('unregistered');
    expect(rowStatus('unregistered', 'unknown')).toBe('unregistered');
  });
});

describe('the card watches the store for every chain', () => {
  const src = readFileSync(join(ROOT, 'components/home/registration-status-card.tsx'), 'utf8');
  test('subscribed, and every supported chain goes through rowStatus', () => {
    expect(src).toContain('useSyncExternalStore(subscribeReceiveSetup, receiveSetupVersion, receiveSetupVersion)');
    // The call sits in the loop over every supported chain, not the active one.
    const loop = src.indexOf('for (const id of supportedEvmChainIds) {');
    const call = src.indexOf('rowStatus(base[id], identityStatusFromReceive(getReceiveSetup(sessionAddress, id)))');
    expect(loop).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(loop);
    expect(src.slice(loop, call)).not.toContain('}');
  });
});
