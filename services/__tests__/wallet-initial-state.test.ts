import { expect, test } from 'bun:test';
import { createConfig, http, serialize } from 'wagmi';
import { mainnet } from 'wagmi/chains';
import { hydrate, version } from '@wagmi/core';
import { readWalletInitialState } from '../wallet-initial-state';

const address = `0x${'12'.repeat(20)}`;
const connection = () => ({ accounts: [address], chainId: 1,
  connector: { id: 'injected', name: 'Test wallet', type: 'injected', uid: 'wallet' } });
const fixture = () => ({ version: Number.parseInt(version.split('.')[0], 10), state: {
  current: 'wallet' as string | null, chainId: 1, connections: new Map<string, unknown>([['wallet', connection()]]),
} });
const read = (saved = fixture()) => readWalletInitialState(() => serialize(saved));

test('restores an identity Wagmi can hydrate and persist before reconnecting', () => {
  const state = read();
  expect(state?.status).toBe('reconnecting');
  expect(state?.connections.get(state.current!)?.accounts).toEqual([address]);
  const config = createConfig({ chains: [mainnet], transports: { [mainnet.id]: http() }, ssr: true, multiInjectedProviderDiscovery: false });
  expect(() => hydrate(config, { initialState: state, reconnectOnMount: true })).not.toThrow();
  expect(config.state.current).toBe('wallet');
});

test('a disconnect, absent active connection, or incompatible schema starts normally', () => {
  for (const current of [null, 'other']) {
    const saved = fixture(); saved.state.current = current;
    expect(read(saved)).toBeUndefined();
  }
  const saved = fixture(); saved.version--;
  expect(read(saved)).toBeUndefined();
});

test('rejects malformed selected and secondary connections before Wagmi persists them', () => {
  for (const uid of ['wallet', 'secondary']) {
    for (const entry of [null, {}, { ...connection(), connector: undefined },
      { ...connection(), accounts: [null] }, { ...connection(), accounts: [] },
      { ...connection(), chainId: '1' }]) {
      const saved = fixture(); saved.state.connections.set(uid, entry);
      expect(read(saved)).toBeUndefined();
    }
  }
});

test('unavailable or malformed storage starts normally', () => {
  for (const getItem of [() => null, () => '{broken', () => { throw Error('blocked'); }]) {
    expect(readWalletInitialState(getItem)).toBeUndefined();
  }
});
