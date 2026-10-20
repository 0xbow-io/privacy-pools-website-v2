import { describe, expect, test } from 'bun:test';
import { privateKeyToAccount } from 'viem/accounts';
import { concat, encodeAbiParameters, keccak256, recoverAddress, toBytes, toHex, type Hex } from 'viem';
import {
  COINBASE_APP_CANNOT_SIGN_MESSAGE, COINBASE_V4_FAILED_MESSAGE, isCoinbaseAppCannotSign, isCoinbaseInAppBrowser, isCoinbaseV4Failed,
  signTypedDataWithCoinbaseFallback, v3HashesLikeV4, coinbaseTwoTapProof, COINBASE_CONFIRM_NEXT_TAP_MESSAGE, CoinbaseConfirmNextTapError, isCoinbaseConfirmNextTap,
} from '../coinbase-typed-data-fallback';
import { SignatureTimeoutError } from '../wallet-signature-timeout';

// The real derivation payload shape (services/sdk-setup.ts buildSecretDerivationPayload).
const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const typedData = {
  domain: {
    name: 'Standardized Secret Derivation', version: '1',
    verifyingContract: '0x0000000000000000000000000000000000000000' as const,
    salt: keccak256(toHex('test-app')),
  },
  types: { SecretDerivation: [{ name: 'purpose', type: 'string' }, { name: 'addressHash', type: 'bytes32' }] },
  primaryType: 'SecretDerivation' as const,
  message: { purpose: 'p', addressHash: keccak256(toBytes(account.address)) },
};

// Independent EIP-712 (v3 rules) digest, written out by hand, not through viem's typed-data code.
function manualV3Digest(): Hex {
  const domainTypeHash = keccak256(toHex('EIP712Domain(string name,string version,address verifyingContract,bytes32 salt)'));
  const domainSep = keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'address' }, { type: 'bytes32' }],
    [domainTypeHash, keccak256(toHex(typedData.domain.name)), keccak256(toHex(typedData.domain.version)), typedData.domain.verifyingContract, typedData.domain.salt],
  ));
  const structTypeHash = keccak256(toHex('SecretDerivation(string purpose,bytes32 addressHash)'));
  const structHash = keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }],
    [structTypeHash, keccak256(toHex(typedData.message.purpose)), typedData.message.addressHash],
  ));
  return keccak256(concat(['0x1901', domainSep, structHash]));
}

const signV4 = () => account.signTypedData(typedData);
const v3Sign = async () => account.sign({ hash: manualV3Digest() });
const cancelled = () => Promise.reject(Object.assign(new Error('User rejected the request.'), { code: 4001 }));
type Call = { method: string; params?: unknown[] };
const provider = (answer: (c: Call) => Promise<unknown>, calls: Call[] = []) => ({
  request: async (c: Call) => { calls.push(c); return answer(c); },
});
const base = { address: account.address, typedData: typedData as never };

describe('isCoinbaseInAppBrowser', () => {
  test('the provider flag or the app user agent, not the extension', () => {
    expect(isCoinbaseInAppBrowser({ provider: { isCoinbaseBrowser: true } })).toBe(true);
    expect(isCoinbaseInAppBrowser({ userAgent: 'Mozilla/5.0 (iPhone) CoinbaseWallet/30.7' })).toBe(true);
    expect(isCoinbaseInAppBrowser({ provider: { isCoinbaseWallet: true }, userAgent: 'Mozilla/5.0 Chrome' })).toBe(false);
    expect(isCoinbaseInAppBrowser({ provider: Object.defineProperty({}, 'isCoinbaseBrowser', { get() { throw new Error('x'); } }) })).toBe(false);
  });
});

describe('v3HashesLikeV4', () => {
  test('flat struct yes; arrays or nested structs no', () => {
    expect(v3HashesLikeV4(typedData.types)).toBe(true);
    expect(v3HashesLikeV4({ A: [{ name: 'x', type: 'uint256[]' }] })).toBe(false);
    expect(v3HashesLikeV4({ A: [{ name: 'b', type: 'B' }], B: [{ name: 'x', type: 'uint256' }] })).toBe(false);
  });
  test('the v4 signature verifies against the hand-written v3 digest (same keys)', async () => {
    expect(await recoverAddress({ hash: manualV3Digest(), signature: await signV4() })).toBe(account.address);
    expect(await v3Sign()).toBe(await signV4());
  });
});

describe('signTypedDataWithCoinbaseFallback: one request per tap', () => {
  test('v4 success is returned untouched, no v3 request', async () => {
    const calls: Call[] = [];
    const sig = await signTypedDataWithCoinbaseFallback({ ...base, signV4, coinbaseInApp: true, useV3: false, provider: provider(v3Sign, calls) });
    expect(sig).toBe(await signV4());
    expect(calls).toEqual([]);
  });

  test('a cancel (4001) in the Coinbase app is NOT re-prompted; it says tap again', async () => {
    const calls: Call[] = [];
    let err: unknown;
    try { await signTypedDataWithCoinbaseFallback({ ...base, signV4: cancelled, coinbaseInApp: true, useV3: false, provider: provider(v3Sign, calls) }); } catch (e) { err = e; }
    expect(isCoinbaseV4Failed(err)).toBe(true);
    expect((err as Error).message).toBe(COINBASE_V4_FAILED_MESSAGE);
    expect(calls).toEqual([]);
  });

  test('the next tap asks with v3: exact method, address and serialized payload; same signature', async () => {
    const calls: Call[] = [];
    const sig = await signTypedDataWithCoinbaseFallback({ ...base, signV4: cancelled, coinbaseInApp: true, useV3: true, provider: provider(v3Sign, calls) });
    expect(sig).toBe(await signV4());
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('eth_signTypedData_v3');
    expect(calls[0].params?.[0]).toBe(account.address);
    const sent = JSON.parse(calls[0].params?.[1] as string);
    expect(sent.primaryType).toBe('SecretDerivation');
    expect(sent.domain).toEqual(typedData.domain);
    expect(sent.message).toEqual(typedData.message);
    expect(sent.types.EIP712Domain.map((f: { name: string }) => f.name)).toEqual(['name', 'version', 'verifyingContract', 'salt']);
    expect(sent.types.SecretDerivation).toEqual(typedData.types.SecretDerivation);
  });

  test('a v3 answer from another key is refused', async () => {
    const other = privateKeyToAccount('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba');
    await expect(signTypedDataWithCoinbaseFallback({ ...base, signV4, coinbaseInApp: true, useV3: true, provider: provider(() => other.sign({ hash: manualV3Digest() })) }))
      .rejects.toThrow(COINBASE_APP_CANNOT_SIGN_MESSAGE);
  });

  test('v3 fails too: CoinbaseAppCannotSign', async () => {
    let err: unknown;
    try { await signTypedDataWithCoinbaseFallback({ ...base, signV4, coinbaseInApp: true, useV3: true, provider: provider(cancelled) }); } catch (e) { err = e; }
    expect(isCoinbaseAppCannotSign(err)).toBe(true);
  });

  test('other wallets and timeouts keep their own error, and never use v3', async () => {
    const calls: Call[] = [];
    await expect(signTypedDataWithCoinbaseFallback({ ...base, signV4: cancelled, coinbaseInApp: false, useV3: true, provider: provider(v3Sign, calls) }))
      .rejects.toThrow('User rejected');
    await expect(signTypedDataWithCoinbaseFallback({ ...base, signV4: () => Promise.reject(new SignatureTimeoutError('initial', 'Coinbase Wallet')), coinbaseInApp: true, useV3: false, provider: provider(v3Sign, calls) }))
      .rejects.toThrow('did not answer');
    expect(calls).toEqual([]);
  });
});


describe('v3 determinism proof spread over two taps (one wallet request per tap)', () => {
  const r = 'a'.repeat(64);
  const sigA = `0x${r}${'1'.repeat(64)}1b` as `0x${string}`;
  const sigSameR = `0x${r.toUpperCase()}${'2'.repeat(64)}1c` as `0x${string}`;
  const sigOtherR = `0x${'b'.repeat(64)}${'1'.repeat(64)}1b` as `0x${string}`;

  test('first v3 tap defers the proof instead of a second request', () => {
    expect(coinbaseTwoTapProof(undefined, sigA)).toBe('defer');
    expect(coinbaseTwoTapProof(null, sigA)).toBe('defer');
  });

  test('next tap with the same r proves determinism', () => {
    expect(coinbaseTwoTapProof(sigA, sigSameR)).toBe('match');
  });

  test('next tap with a different r is refused', () => {
    expect(coinbaseTwoTapProof(sigA, sigOtherR)).toBe('mismatch');
  });

  test('the defer error is recognisable and tells the user to tap again', () => {
    const err = new CoinbaseConfirmNextTapError();
    expect(isCoinbaseConfirmNextTap(err)).toBe(true);
    expect(err.message).toBe(COINBASE_CONFIRM_NEXT_TAP_MESSAGE);
    expect(err.message).not.toContain('—');
  });

  test('a v3 tap issues exactly one wallet request', async () => {
    const calls: Call[] = [];
    await signTypedDataWithCoinbaseFallback({
      ...base, signV4: () => Promise.reject(new Error('v4 must not be called')),
      coinbaseInApp: true, useV3: true, provider: provider(v3Sign, calls),
    });
    expect(calls.map((c) => c.method)).toEqual(['eth_signTypedData_v3']);
  });
});
