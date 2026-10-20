import { describe, expect, test } from 'bun:test';
import { createEmitter } from '@wagmi/core/internal';
import { custom, parseTransaction, recoverTransactionAddress, recoverTypedDataAddress, stringify, type Hex } from 'viem';
import { optimism, sepolia } from 'viem/chains';

import {
  NoPasskeySignerError,
  buildPickerAccounts,
  depositSignerFor,
  planForPick,
} from '@/services/passkey-eoa/account-picker';
import { passkeyEoaConnector, setActivePasskeyEoa } from '@/services/passkey-eoa/connector';
import { PasskeyEoaError, classifyNativePasskeyError } from '@/services/passkey-eoa/errors';
import { decodeBase64Any, takePrfFromNativeResult } from '@/services/passkey-eoa/prf-response';
import { loadPasskeyEoaRecord, savePasskeyEoaRecord, type PublicKV } from '@/services/passkey-eoa/store';

const PASSKEY = '0xE956DC965dfe5a11f9F67cF2a6C5B865FA67E3ae' as const; // EOA of PRF 0x00..0x1f
const prfVector = () => new Uint8Array(32).map((_, i) => i);
const failureOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof PasskeyEoaError ? e.failure : 'other';
  }
};
const imported = [
  { id: 'aaaaaaaaaaaa', name: 'Swift Fox', address: '0x1111111111111111111111111111111111111111' },
  { id: 'bbbbbbbbbbbb', name: 'Calm Owl', address: '0x2222222222222222222222222222222222222222' },
];

describe('account picker', () => {
  test('passkey account first, then imported keys, deduped', () => {
    const list = buildPickerAccounts(PASSKEY, [...imported, imported[0]]);
    expect(list.map((a) => a.id)).toEqual(['passkey', 'aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
    expect(list[0]).toMatchObject({ kind: 'passkey', address: PASSKEY });
  });

  test('without a passkey sign-in the imported keys are listed but cannot be used', () => {
    const list = buildPickerAccounts(null, imported);
    expect(list.map((a) => a.kind)).toEqual(['imported', 'imported']);
    expect(() => planForPick(list[0], null)).toThrow(new NoPasskeySignerError().message);
  });

  test('the deposit signer is always the passkey EOA', () => {
    for (const account of buildPickerAccounts(PASSKEY, imported)) {
      expect(depositSignerFor(account, PASSKEY)).toBe(PASSKEY);
    }
  });

  test('passkey pick = wallet mode; imported pick = key identity with the passkey EOA as payer', () => {
    const [pk, first] = buildPickerAccounts(PASSKEY, imported);
    expect(planForPick(pk, PASSKEY)).toEqual({ privacyIdentity: { mode: 'wallet', address: PASSKEY }, onChainSigner: PASSKEY });
    expect(planForPick(first, PASSKEY)).toEqual({
      privacyIdentity: { mode: 'key', importedId: 'aaaaaaaaaaaa', address: imported[0].address },
      onChainSigner: PASSKEY,
    });
  });
});

describe('native passkey result', () => {
  const authData = (flags: number) => {
    const b = new Uint8Array(37);
    b[32] = flags;
    return Buffer.from(b).toString('base64url');
  };

  test('decodes base64 and base64url alike', () => {
    const bytes = prfVector();
    expect(decodeBase64Any(Buffer.from(bytes).toString('base64'))).toEqual(bytes);
    expect(decodeBase64Any(Buffer.from(bytes).toString('base64url'))).toEqual(bytes);
  });

  test('takes a 32-byte PRF and blanks the string on the result', () => {
    const result = {
      response: { authenticatorData: authData(0x05) },
      clientExtensionResults: { prf: { results: { first: Buffer.from(prfVector()).toString('base64') as unknown } } },
    };
    expect(takePrfFromNativeResult(result, true)).toEqual(prfVector());
    expect(result.clientExtensionResults.prf.results.first).toBeUndefined();
  });

  test('fails closed: no UV, no PRF, short PRF', () => {
    const prf = Buffer.from(prfVector()).toString('base64');
    const noUv = { response: { authenticatorData: authData(0x01) }, clientExtensionResults: { prf: { results: { first: prf } } } };
    expect(failureOf(() => takePrfFromNativeResult(noUv, true))).toBe('not-verified');
    const none = { response: { authenticatorData: authData(0x05) } };
    expect(failureOf(() => takePrfFromNativeResult(none, true))).toBe('prf-unsupported');
    const short = { response: { authenticatorData: authData(0x05) }, clientExtensionResults: { prf: { results: { first: 'AAAA' } } } };
    expect(failureOf(() => takePrfFromNativeResult(short, true))).toBe('prf-unsupported');
  });

  test('maps native errors to short copy without forwarding native text', () => {
    expect(classifyNativePasskeyError({ error: 'UserCancelled', message: 'x' })).toBe('cancelled');
    expect(classifyNativePasskeyError({ error: 'NoCredentials', message: 'x' })).toBe('no-passkey');
    expect(classifyNativePasskeyError({ error: 'Native error', message: 'RP ID cannot be validated.' })).toBe('not-associated');
    expect(classifyNativePasskeyError({ error: 'NotSupported', message: '' })).toBe('unsupported');
    expect(new PasskeyEoaError('cancelled').message).not.toMatch(/—/);
  });
});

describe('public record store', () => {
  test('round-trips only the address and credential id', async () => {
    const mem = new Map<string, string>();
    const kv: PublicKV = { get: async (k) => mem.get(k) ?? null, set: async (k, v) => { mem.set(k, v); }, remove: async (k) => { mem.delete(k); } };
    await savePasskeyEoaRecord(kv, { address: PASSKEY, credentialId: 'abc_-1' });
    expect(JSON.parse([...mem.values()][0])).toEqual({ address: PASSKEY, credentialId: 'abc_-1' });
    expect(await loadPasskeyEoaRecord(kv)).toEqual({ address: PASSKEY, credentialId: 'abc_-1' });
  });
});

describe('passkey EOA connector', () => {
  test('eth_sendTransaction: one passkey prompt, broadcast signed by the passkey EOA', async () => {
    const calls: string[] = [];
    let broadcast: Hex | null = null;
    const transport = custom({
      async request({ method, params }: { method: string; params?: unknown[] }) {
        calls.push(method);
        switch (method) {
          case 'eth_chainId': return `0x${sepolia.id.toString(16)}`;
          case 'eth_getTransactionCount': return '0x7';
          case 'eth_estimateGas': return '0x5208';
          case 'eth_maxPriorityFeePerGas': return '0xf4240';
          case 'eth_getBlockByNumber': return { baseFeePerGas: '0x3b9aca00', number: '0x1', hash: `0x${'11'.repeat(32)}`, timestamp: '0x1', transactions: [] };
          case 'eth_sendRawTransaction': broadcast = (params as Hex[])[0]; return `0x${'ab'.repeat(32)}`;
          default: throw new Error(`unexpected ${method}`);
        }
      },
    });
    let prompts = 0;
    const factory = passkeyEoaConnector({
      transportFor: () => transport,
      requestPrf: async () => { prompts++; calls.push('prompt'); return { prf: prfVector(), credentialId: null }; },
    });
    const connector = factory({ chains: [sepolia], emitter: createEmitter('test') } as never);
    setActivePasskeyEoa({ address: PASSKEY, credentialId: null });
    try {
      const provider = await connector.getProvider({ chainId: sepolia.id });
      expect(await provider.request({ method: 'eth_accounts' })).toEqual([PASSKEY]);
      expect(prompts).toBe(0); // reading the address never prompts
      const hash = await provider.request({
        method: 'eth_sendTransaction',
        params: [{ from: PASSKEY, to: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', value: '0x1', data: '0x' }],
      });
      expect(hash).toBe(`0x${'ab'.repeat(32)}`);
      expect(prompts).toBe(1);
      expect(broadcast).not.toBeNull();
      expect(await recoverTransactionAddress({ serializedTransaction: broadcast as never })).toBe(PASSKEY);
      // The prompt comes after every read the transaction needed, right before the broadcast.
      const prompt = calls.indexOf('prompt');
      expect(calls.filter((c) => c === 'prompt')).toHaveLength(1);
      expect(calls.slice(prompt + 1)).toEqual(['eth_sendRawTransaction']);
      for (const read of ['eth_getTransactionCount', 'eth_estimateGas']) {
        expect(calls.indexOf(read)).toBeGreaterThanOrEqual(0);
        expect(calls.indexOf(read)).toBeLessThan(prompt);
      }
    } finally {
      setActivePasskeyEoa(null);
    }
  });

  test('wallet_switchEthereumChain moves later reads and sends to the new chain', async () => {
    const seen: { chain: number; method: string; tx?: Hex }[] = [];
    const transportFor = (chain: number) => custom({
      async request({ method, params }: { method: string; params?: unknown[] }) {
        seen.push({ chain, method, tx: method === 'eth_sendRawTransaction' ? (params as Hex[])[0] : undefined });
        switch (method) {
          case 'eth_chainId': return `0x${chain.toString(16)}`;
          case 'eth_getBalance': return '0x1';
          case 'eth_getTransactionCount': return '0x0';
          case 'eth_estimateGas': return '0x5208';
          case 'eth_maxPriorityFeePerGas': return '0xf4240';
          case 'eth_getBlockByNumber': return { baseFeePerGas: '0x3b9aca00', number: '0x1', hash: `0x${'11'.repeat(32)}`, timestamp: '0x1', transactions: [] };
          case 'eth_sendRawTransaction': return `0x${'ab'.repeat(32)}`;
          default: throw new Error(`unexpected ${method}`);
        }
      },
    });
    const factory = passkeyEoaConnector({ transportFor, requestPrf: async () => ({ prf: prfVector(), credentialId: null }) });
    const connector = factory({ chains: [sepolia, optimism], emitter: createEmitter('test') } as never);
    setActivePasskeyEoa({ address: PASSKEY, credentialId: null });
    try {
      const provider = await connector.getProvider({ chainId: sepolia.id });
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${optimism.id.toString(16)}` }] });
      expect(await provider.request({ method: 'eth_chainId' })).toBe(`0x${optimism.id.toString(16)}`);
      expect(await connector.getChainId()).toBe(optimism.id);
      await provider.request({ method: 'eth_getBalance', params: [PASSKEY, 'latest'] });
      await provider.request({
        method: 'eth_sendTransaction',
        params: [{ from: PASSKEY, to: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', value: '0x1', data: '0x' }],
      });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.filter((s) => s.chain !== optimism.id)).toEqual([]);
      const sent = seen.find((s) => s.method === 'eth_sendRawTransaction');
      expect(sent?.tx).toBeDefined();
      expect(parseTransaction(sent!.tx!).chainId).toBe(optimism.id);
    } finally {
      setActivePasskeyEoa(null);
    }
  });

  test('eth_signTypedData_v4 as wagmi sends it (JSON, bigints as strings) recovers to the passkey EOA', async () => {
    const factory = passkeyEoaConnector({ transportFor: () => custom({ request: async () => null }), requestPrf: async () => ({ prf: prfVector(), credentialId: null }) });
    const connector = factory({ chains: [sepolia], emitter: createEmitter('test') } as never);
    setActivePasskeyEoa({ address: PASSKEY, credentialId: null });
    try {
      const typed = {
        domain: { name: 'Privacy Pools', version: '1', chainId: 11155111, verifyingContract: '0x0000000000000000000000000000000000000000' as const },
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' },
          ],
          Msg: [{ name: 'v', type: 'uint256' }, { name: 's', type: 'string' }],
        },
        primaryType: 'Msg' as const,
        message: { v: 123456789012345678901234567890n, s: 'hi' },
      };
      const provider = await connector.getProvider({ chainId: sepolia.id });
      const sig = await provider.request({ method: 'eth_signTypedData_v4', params: [PASSKEY, stringify(typed)] }) as Hex;
      expect(await recoverTypedDataAddress({ ...typed, signature: sig } as never)).toBe(PASSKEY);
    } finally {
      setActivePasskeyEoa(null);
    }
  });

  test('refuses to sign for another address', async () => {
    const factory = passkeyEoaConnector({ transportFor: () => custom({ request: async () => null }), requestPrf: async () => ({ prf: prfVector(), credentialId: null }) });
    const connector = factory({ chains: [sepolia], emitter: createEmitter('test') } as never);
    setActivePasskeyEoa({ address: PASSKEY, credentialId: null });
    try {
      const provider = await connector.getProvider({ chainId: sepolia.id });
      await expect(provider.request({ method: 'personal_sign', params: ['0x00', '0x1111111111111111111111111111111111111111'] })).rejects.toThrow();
    } finally {
      setActivePasskeyEoa(null);
    }
  });
});
