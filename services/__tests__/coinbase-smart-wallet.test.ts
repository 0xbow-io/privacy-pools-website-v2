import { describe, expect, test } from 'bun:test';
import { capabilitiesSayContractAccount, isPlainEcdsaSignature } from '../signer-determinism';
import { walletCapabilities } from '../wallet-signature-timeout';

describe('capabilitiesSayContractAccount (DEV-427 mobile)', () => {
  const supported = { '0x1': { atomic: { status: 'supported' } } };
  test('undeployed smart wallet: no code + atomic supported on this chain', () => {
    expect(capabilitiesSayContractAccount(supported, 1, 'eoa')).toBe(true);
    expect(capabilitiesSayContractAccount({ '0x2105': { atomicBatch: { supported: true } } }, 8453, 'eoa')).toBe(true);
    expect(capabilitiesSayContractAccount({ '8453': { atomic: { status: 'supported' } } }, 8453, 'eoa')).toBe(true);
  });
  test('7702-delegated EOA keeps the wallet signature even though it reports supported', () => {
    expect(capabilitiesSayContractAccount(supported, 1, 'delegated-eoa')).toBe(false);
  });
  test('no code verdict (read failed) or a deployed contract is not decided here', () => {
    expect(capabilitiesSayContractAccount(supported, 1, null)).toBe(false);
    expect(capabilitiesSayContractAccount(supported, 1, 'contract')).toBe(false);
  });
  test('a delegation or smart account on another chain says nothing about this one', () => {
    expect(capabilitiesSayContractAccount({ '0x2105': { atomic: { status: 'supported' } } }, 1, 'eoa')).toBe(false);
  });
  test('plain EOA: ready, unsupported, or no answer', () => {
    expect(capabilitiesSayContractAccount({ '0x1': { atomic: { status: 'ready' } } }, 1, 'eoa')).toBe(false);
    expect(capabilitiesSayContractAccount({ '0x1': { atomic: { status: 'unsupported' } } }, 1, 'eoa')).toBe(false);
    expect(capabilitiesSayContractAccount({}, 1, 'eoa')).toBe(false);
    expect(capabilitiesSayContractAccount(null, 1, 'eoa')).toBe(false);
    expect(capabilitiesSayContractAccount('x', 1, 'eoa')).toBe(false);
  });
});

describe('isPlainEcdsaSignature', () => {
  test('only 65 bytes passes', () => {
    expect(isPlainEcdsaSignature(`0x${'ab'.repeat(65)}`)).toBe(true);
    expect(isPlainEcdsaSignature(`0x${'ab'.repeat(64)}`)).toBe(false);
    expect(isPlainEcdsaSignature(`0x${'ab'.repeat(300)}`)).toBe(false);
  });
});

describe('walletCapabilities', () => {
  const addr = '0x1111111111111111111111111111111111111111';
  test('asks the wallet provider only, with the address', async () => {
    const calls: unknown[] = [];
    const caps = { '0x2105': { atomic: { status: 'supported' } } };
    const connector = { id: 'injected', getProvider: async () => ({ request: async (a: unknown) => { calls.push(a); return caps; } }) };
    expect(await walletCapabilities(connector, addr)).toEqual(caps);
    expect(calls).toEqual([{ method: 'wallet_getCapabilities', params: [addr] }]);
  });
  test('null on an error, a missing provider, or a wallet that never answers', async () => {
    expect(await walletCapabilities({ getProvider: async () => ({ request: async () => { throw new Error('4200'); } }) }, addr)).toBeNull();
    expect(await walletCapabilities(null, addr)).toBeNull();
    expect(await walletCapabilities({ getProvider: async () => ({ request: () => new Promise(() => {}) }) }, addr, 20)).toBeNull();
  });
});

describe('walletCapabilities: a throwing request getter', () => {
  test('returns null instead of rejecting', async () => {
    const provider = Object.defineProperty({}, 'request', { get() { throw new Error('boom'); } });
    expect(await walletCapabilities({ getProvider: async () => provider }, '0x1111111111111111111111111111111111111111')).toBeNull();
  });
});

import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toBytes, toHex } from 'viem';
import { COINBASE_7702_PROXY, coinbasePasskeyFallbackApplies, contractWalletVerdict, delegationTarget } from '../signer-determinism';
import { isCoinbaseAppCannotSign, isCoinbaseV4Failed, signTypedDataWithCoinbaseFallback } from '../coinbase-typed-data-fallback';

// DEV-427, Mike: an EOA delegated to Coinbase's 7702 proxy. The passkey is a
// fallback only: every wallet is asked to sign first.
describe('Coinbase 7702 EOA: wallet signature first, passkey only after the app fails', () => {
  const cbCode = `0xef0100${COINBASE_7702_PROXY.slice(2)}`;
  const mmCode = '0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b';
  const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const typedData = {
    domain: { name: 'Standardized Secret Derivation', version: '1', verifyingContract: '0x0000000000000000000000000000000000000000' as const, salt: keccak256(toHex('t')) },
    types: { SecretDerivation: [{ name: 'purpose', type: 'string' }, { name: 'addressHash', type: 'bytes32' }] },
    primaryType: 'SecretDerivation' as const,
    message: { purpose: 'p', addressHash: keccak256(toBytes(account.address)) },
  };
  const sign = () => account.signTypedData(typedData);
  const baseAppError = () => Promise.reject(Object.assign(new Error('User rejected the request.'), { code: 4001 }));
  const run = (signV4: () => Promise<`0x${string}`>, coinbaseInApp: boolean, v3: () => Promise<unknown>, useV3 = false) =>
    signTypedDataWithCoinbaseFallback({ signV4, coinbaseInApp, useV3, address: account.address, typedData: typedData as never, provider: { request: v3 as never } });

  test('reads the delegate', () => {
    expect(delegationTarget(cbCode)).toBe(COINBASE_7702_PROXY);
    expect(contractWalletVerdict(cbCode)).toBe('delegated-eoa');
    expect(delegationTarget('0x')).toBeNull();
  });

  test('Coinbase extension with a Coinbase 7702 EOA signs normally (no passkey)', async () => {
    expect(await run(sign, false, baseAppError)).toBe(await sign());
  });

  test('MetaMask with a 7702 EOA signs normally, and its delegation never qualifies', async () => {
    expect(await run(sign, false, baseAppError)).toBe(await sign());
    expect(coinbasePasskeyFallbackApplies({ code: mmCode, codeVerdict: 'delegated-eoa', capabilities: null, chainId: 1 })).toBe(false);
  });

  test('Coinbase app that DOES sign keeps the signature account', async () => {
    expect(await run(sign, true, baseAppError)).toBe(await sign());
  });

  test('Coinbase app failure (v4, then v3 on the next tap) on a Coinbase 7702 EOA leads to the passkey', async () => {
    let err: unknown;
    try { await run(baseAppError, true, baseAppError); } catch (e) { expect(isCoinbaseV4Failed(e)).toBe(true); }
    try { await run(baseAppError, true, baseAppError, true); } catch (e) { err = e; }
    expect(isCoinbaseAppCannotSign(err)).toBe(true);
    expect(coinbasePasskeyFallbackApplies({ code: cbCode, codeVerdict: 'delegated-eoa', capabilities: null, chainId: 1 })).toBe(true);
  });

  test('Coinbase app failure on an undeployed smart wallet leads to the passkey; on a plain EOA it does not', () => {
    const supported = { '0x1': { atomic: { status: 'supported' } } };
    expect(coinbasePasskeyFallbackApplies({ code: '0x', codeVerdict: 'eoa', capabilities: supported, chainId: 1 })).toBe(true);
    expect(coinbasePasskeyFallbackApplies({ code: '0x', codeVerdict: 'eoa', capabilities: { '0x1': { atomic: { status: 'ready' } } }, chainId: 1 })).toBe(false);
    expect(coinbasePasskeyFallbackApplies({ code: undefined, codeVerdict: null, capabilities: supported, chainId: 1 })).toBe(false);
  });

  test('a failure outside the Coinbase app is the wallet error, never the passkey trigger', async () => {
    let err: unknown;
    try { await run(baseAppError, false, sign); } catch (e) { err = e; }
    expect(isCoinbaseAppCannotSign(err)).toBe(false);
  });
});
