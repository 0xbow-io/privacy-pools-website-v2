// DEV-589: registering on BNB Chain from a mobile wallet failed with the
// generic "could not send" line, on BNB only, after DEV-542 started sending an
// explicit `gasPrice` there. This drives the real viem send path wagmi uses for
// an injected wallet (json-rpc account -> eth_sendTransaction) against an
// EIP-1193 provider shaped like a legacy-only mobile wallet whose node has its
// own minimum gas price, and checks what reaches the wallet.
import { describe, expect, test } from 'bun:test';
import { createWalletClient, custom, type Address, type Hex } from 'viem';
import { bsc, mainnet } from 'viem/chains';

import { collectErrorText, describeRegistrationError } from '../gasless-registration';
import { priceWalletTx, walletTxFields, type FeeReadClient } from '../wallet-tx-fees';

const OWNER = '0x1111111111111111111111111111111111111111' as Address;
const KEYSTORE = '0x6E463391c79b7e1A88eF26E0B023f9A6C9938a71' as Address;
// setViewingKey(bytes32), as sent on BSC.
const DATA = '0x73897d65425b4e9cc37ca2e92a0b6086c1bc1eaad201e661bc3ef4e1e23652ac91438155' as Hex;
// The app RPC's eth_gasPrice on BSC, read 2026-10-24.
const APP_RPC_GAS_PRICE = 50_000_000n;
// A wallet node that keeps an older, higher floor.
const WALLET_NODE_MIN_GAS_PRICE = 100_000_000n;
// setViewingKey estimate seen on BSC (0x9e9fac8f...).
const ESTIMATE = 51_084n;

type Sent = Record<string, string | undefined>;

/**
 * Legacy-only mobile wallet: refuses 1559 fields, its node refuses a gas price
 * under its floor. `unsupportedCode` is what it answers an unknown method with:
 * -32601 (MetaMask style) or 4200 (EIP-1193 "unsupported method").
 */
function mobileLegacyWallet(chainIdHex: Hex, unsupportedCode = -32601) {
  const sent: Sent[] = [];
  const rpcError = (code: number, message: string) => Object.assign(new Error(message), { code });
  const provider = {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === 'eth_chainId') return chainIdHex;
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [OWNER];
      if (method === 'eth_sendTransaction') {
        const tx = (params?.[0] ?? {}) as Sent;
        sent.push(tx);
        if (tx.maxFeePerGas !== undefined || tx.maxPriorityFeePerGas !== undefined) {
          throw rpcError(-32000, 'EIP-1559 transactions are not supported on this network');
        }
        if (tx.gasPrice !== undefined && BigInt(tx.gasPrice) < WALLET_NODE_MIN_GAS_PRICE) {
          throw rpcError(-32000, 'transaction underpriced');
        }
        return `0x${'ab'.repeat(32)}`;
      }
      throw rpcError(unsupportedCode, `unsupported ${method}`);
    },
  };
  return { provider, sent };
}

/** The app RPC on BSC: 0.05 gwei, blocks with baseFeePerGas 0. */
function appRpc(): FeeReadClient {
  return {
    getGasPrice: async () => APP_RPC_GAS_PRICE,
    getBlock: async () => ({ baseFeePerGas: 0n }),
    estimateMaxPriorityFeePerGas: async () => 0n,
    estimateGas: async () => ESTIMATE,
  };
}

async function send(chain: typeof bsc | typeof mainnet, provider: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> }, fields: object) {
  const wallet = createWalletClient({ chain, transport: custom(provider) });
  return wallet.sendTransaction({ account: OWNER, chain, to: KEYSTORE, data: DATA, value: 0n, ...fields });
}

describe('BNB Chain wallet tx shape against a mobile legacy-only wallet (DEV-589)', () => {
  test('the registration leg reaches the wallet with a gas limit and no fee fields, and is sent', async () => {
    const { provider, sent } = mobileLegacyWallet('0x38');
    const plan = await priceWalletTx(appRpc(), { account: OWNER, to: KEYSTORE, data: DATA, value: 0n }, 80_000n, 56);
    const hash = await send(bsc, provider, walletTxFields(plan));
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sent).toHaveLength(1);
    const tx = sent[0];
    expect(tx.gas).toBe(`0x${((ESTIMATE * 12n) / 10n).toString(16)}`);
    for (const field of ['gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas', 'type']) expect(tx[field]).toBeUndefined();
    expect(tx.to?.toLowerCase()).toBe(KEYSTORE.toLowerCase());
    expect(tx.data).toBe(DATA);
  });

  test('the DEV-542 shape (explicit app-RPC gasPrice) is what such a wallet refuses, and the user is told why', async () => {
    const { provider } = mobileLegacyWallet('0x38');
    const err = await send(bsc, provider, { gas: (ESTIMATE * 12n) / 10n, gasPrice: APP_RPC_GAS_PRICE }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(describeRegistrationError(message, false, 'BNB Chain', { detail: collectErrorText(err), nativeSymbol: 'BNB' }))
      .toBe('BNB Chain refused the network fee your wallet set. Try again.');
  });

  test('a wallet answering 4200 to wallet_sendTransaction: viem hides the node reason, the console still shows the trail', async () => {
    // viem retries a -32000 eth_sendTransaction refusal as wallet_sendTransaction
    // and, on a 4200 answer, throws THAT error: the "underpriced" is gone from
    // the whole chain. Recorded so nobody expects the reason to survive here.
    const { provider } = mobileLegacyWallet('0x38', 4200);
    const err = await send(bsc, provider, { gasPrice: APP_RPC_GAS_PRICE }).catch((e: unknown) => e);
    const detail = collectErrorText(err);
    expect(detail).not.toMatch(/underpriced/i);
    expect(detail).toContain('wallet_sendTransaction');
    // And with the fix the wallet never sees a fee it could refuse.
    const fixed = mobileLegacyWallet('0x38', 4200);
    const plan = await priceWalletTx(appRpc(), { account: OWNER, to: KEYSTORE, data: DATA, value: 0n }, 80_000n, 56);
    expect(await send(bsc, fixed.provider, walletTxFields(plan))).toMatch(/^0x/);
  });

  test('the setAuthPolicy leg with no estimate leaves gas to the wallet too', async () => {
    const { provider, sent } = mobileLegacyWallet('0x38');
    const rpc = { ...appRpc(), estimateGas: () => Promise.reject(new Error('rpc down')) };
    const plan = await priceWalletTx(rpc, { account: OWNER, to: KEYSTORE, data: DATA, value: 0n }, null, 56);
    await send(bsc, provider, walletTxFields(plan));
    expect(Object.keys(sent[0]).filter((k) => /gas|fee|type/i.test(k))).toEqual([]);
  });

  test('Ethereum keeps the DEV-542 fee caps', async () => {
    const rpc: FeeReadClient = { ...appRpc(), getBlock: async () => ({ baseFeePerGas: 100_000_000n }), estimateMaxPriorityFeePerGas: async () => 1n };
    const plan = await priceWalletTx(rpc, { account: OWNER, to: KEYSTORE, data: DATA, value: 0n }, null, 1);
    expect(walletTxFields(plan)).toMatchObject({ maxFeePerGas: 300_000_000n, maxPriorityFeePerGas: 100_000_000n });
  });
});
