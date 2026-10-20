import { describe, expect, test } from 'bun:test';
import { isStaleConnectorError, pruneBareRestoredConnection } from '../stale-connector';

describe('isStaleConnectorError', () => {
  test('matches the PRODUCTION (minified) message — the case the old regex missed', () => {
    // Verbatim from the shipped bundle (Pat's screenshot, 2026-08-28). The old
    // guard required the literal `connection.` prefix and never fired in prod.
    expect(isStaleConnectorError('u.connector.getChainId is not a function')).toBe(true);
  });

  test('matches the dev-bundle message the old regex was written against', () => {
    expect(isStaleConnectorError('connection.connector.getChainId is not a function')).toBe(true);
  });

  test('matches other connector methods and other minified names', () => {
    expect(isStaleConnectorError('e.connector.getAccounts is not a function')).toBe(true);
    expect(isStaleConnectorError('_a.connector.getProvider is not a function')).toBe(true);
    expect(isStaleConnectorError('TypeError: u.connector.getChainId is not a function')).toBe(true);
  });

  test('does not match unrelated not-a-function errors', () => {
    expect(isStaleConnectorError('foo.getChainId is not a function')).toBe(false);
    expect(isStaleConnectorError('u.connect is not a function')).toBe(false);
    expect(isStaleConnectorError('x.collector.getChainId is not a function')).toBe(false);
  });

  test('does not match ordinary failures or empties', () => {
    expect(isStaleConnectorError('User rejected the request.')).toBe(false);
    expect(isStaleConnectorError('')).toBe(false);
    expect(isStaleConnectorError(null)).toBe(false);
    expect(isStaleConnectorError(undefined)).toBe(false);
  });
});

describe('pruneBareRestoredConnection', () => {
  const live = { getChainId: () => 1, disconnect: async () => undefined };
  const bare = { id: 'io.metamask', name: 'MetaMask', type: 'injected', uid: 'a' };
  const state = (connections: [string, unknown][], current: string | null) => ({
    chainId: 1,
    connections: new Map(connections.map(([k, connector]) => [k, { connector }])),
    current,
    status: 'connected' as const,
  });

  test('drops the current connection when its connector is a method-less restored record', () => {
    const next = pruneBareRestoredConnection(state([['a', bare]], 'a'));
    expect(next).not.toBeNull();
    expect(next!.connections.size).toBe(0);
    expect(next!.current).toBeNull();
    expect(next!.status).toBe('disconnected');
  });

  test('leaves a live connector alone (a reconnect repaired the record meanwhile)', () => {
    expect(pruneBareRestoredConnection(state([['a', live]], 'a'))).toBeNull();
  });

  test('promotes the next live connection when one remains', () => {
    const next = pruneBareRestoredConnection(state([['a', bare], ['b', live]], 'a'));
    expect(next!.current).toBe('b');
    expect(next!.status).toBe('connected');
    expect(next!.connections.has('a')).toBe(false);
  });

  test('does nothing with no current connection', () => {
    expect(pruneBareRestoredConnection(state([], null))).toBeNull();
  });
});

describe('pruneBareRestoredConnection: several restored records', () => {
  const live = { getChainId: () => 1, disconnect: async () => undefined };
  const bare = (uid: string) => ({ id: 'io.metamask', name: 'MetaMask', type: 'injected', uid });
  const state = (connections: [string, unknown][], current: string | null) => ({
    chainId: 1,
    connections: new Map(connections.map(([k, connector]) => [k, { connector }])),
    current,
    status: 'reconnecting' as const,
  });

  test('two bare records: nothing is promoted, the session is disconnected', () => {
    const next = pruneBareRestoredConnection(state([['a', bare('a')], ['b', bare('b')]], 'a'));
    expect(next!.connections.size).toBe(0);
    expect(next!.current).toBeNull();
    expect(next!.status).toBe('disconnected');
  });

  test('bare, bare, live: the live one becomes current and the bare ones are gone', () => {
    const next = pruneBareRestoredConnection(state([['a', bare('a')], ['b', bare('b')], ['c', live]], 'a'));
    expect(next!.current).toBe('c');
    expect([...next!.connections.keys()]).toEqual(['c']);
    expect(next!.status).toBe('reconnecting');
  });
});
