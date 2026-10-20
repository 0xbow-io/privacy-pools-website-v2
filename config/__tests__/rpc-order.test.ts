import { describe, expect, test } from 'bun:test';
import { alchemyHostFor, buildRpcOrder } from '@/config/rpc-order';

const ALCHEMY_HOST = 'eth-sepolia.g.alchemy.com';
const PUBLIC = 'https://ethereum-sepolia-rpc.publicnode.com';
const QUIKNODE = 'https://dry-ultra-sound.ethereum-sepolia.quiknode.pro/abc/';

/**
 * The order is the whole point, and it is the kind of thing that regresses
 * silently: the deployed app sat on a rate-limited endpoint that shed 72 of 232
 * block reads in one measured load while an Alchemy key was configured in the
 * same environment, because an explicit RPC_URL used to win outright.
 */
describe('buildRpcOrder', () => {
  test('Alchemy leads when a key is set, with the explicit fallback behind it', () => {
    expect(buildRpcOrder('KEY', ALCHEMY_HOST, QUIKNODE, undefined, PUBLIC)).toEqual([
      `https://${ALCHEMY_HOST}/v2/KEY`,
      QUIKNODE,
      PUBLIC,
    ]);
  });

  test('an explicitly configured RPC_URL is demoted, never discarded', () => {
    const order = buildRpcOrder('KEY', ALCHEMY_HOST, undefined, QUIKNODE, PUBLIC);
    expect(order[0]).toBe(`https://${ALCHEMY_HOST}/v2/KEY`);
    expect(order).toContain(QUIKNODE);
  });

  test('with no Alchemy key the configured endpoint leads (the escape hatch)', () => {
    expect(buildRpcOrder(undefined, ALCHEMY_HOST, undefined, QUIKNODE, PUBLIC)).toEqual([
      QUIKNODE,
      PUBLIC,
    ]);
  });

  test('the public node is the floor, so nothing configured still works', () => {
    expect(buildRpcOrder(undefined, ALCHEMY_HOST, undefined, undefined, PUBLIC)).toEqual([PUBLIC]);
  });

  test('de-dupes, so an endpoint is never its own fallback', () => {
    const alchemy = `https://${ALCHEMY_HOST}/v2/KEY`;
    expect(buildRpcOrder('KEY', ALCHEMY_HOST, alchemy, alchemy, PUBLIC)).toEqual([alchemy, PUBLIC]);
  });

  test('ignores blank and whitespace-only values', () => {
    expect(buildRpcOrder('KEY', ALCHEMY_HOST, '   ', '', PUBLIC)).toEqual([
      `https://${ALCHEMY_HOST}/v2/KEY`,
      PUBLIC,
    ]);
  });

  test('trims, so a stray newline in a dashboard value cannot break a URL', () => {
    expect(buildRpcOrder(undefined, ALCHEMY_HOST, undefined, `${QUIKNODE}\n`, PUBLIC)[0]).toBe(QUIKNODE);
  });
});

describe('ALCHEMY_HOST_BY_CHAIN', () => {
  test('every chain the app can register that Alchemy serves has a host', () => {
    // Verified live 2026-08-27 with the project key.
    expect(alchemyHostFor(1)).toBe('eth-mainnet.g.alchemy.com');
    expect(alchemyHostFor(11155111)).toBe('eth-sepolia.g.alchemy.com');
    expect(alchemyHostFor(10)).toBe('opt-mainnet.g.alchemy.com');
    expect(alchemyHostFor(56)).toBe('bnb-mainnet.g.alchemy.com');
  });

  test('a chain Alchemy does not serve has none, so it keeps its own endpoint', () => {
    // Citrea. Absence is the correct answer here, not an oversight.
    expect(alchemyHostFor(4114)).toBeUndefined();
  });

  test('an unknown chain yields no Alchemy primary rather than a bogus host', () => {
    expect(alchemyHostFor(999_999)).toBeUndefined();
    expect(buildRpcOrder('KEY', alchemyHostFor(999_999), undefined, undefined, 'https://x')).toEqual([
      'https://x',
    ]);
  });

  test('a mapped chain picks Alchemy up automatically from the key alone', () => {
    expect(buildRpcOrder('KEY', alchemyHostFor(56), undefined, undefined, 'https://bsc-dataseed.binance.org')).toEqual([
      'https://bnb-mainnet.g.alchemy.com/v2/KEY',
      'https://bsc-dataseed.binance.org',
    ]);
  });
});
