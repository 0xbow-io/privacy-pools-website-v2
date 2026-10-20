// Headless EIP-6963 EVM wallet for modal-state captures (the EVM sibling of
// .pwcheck/headless-wallet.ts, which is Sui/Wallet-Standard). The provider is
// announced via EIP-6963 so wagmi discovers it; signing happens node-side via
// viem (the key never enters the page). ALL read RPC goes through an in-page
// fetch to the Sepolia RPC URL, so it flows through the fixture router like
// every other request. eth_sendTransaction is HARD-REJECTED by default: capture
// sessions must never submit on-chain transactions.
//
// `{ liveSend: true }` opts a caller INTO broadcasting, for the on-chain e2e
// runs (.pwcheck/e2e-sepolia.ts) that have to actually shield/withdraw/send.
// It is off unless asked for, so no capture or visual run can spend by accident.

import type { Page } from 'playwright';
import { createWalletClient, http } from 'viem';
import { base, bsc, mainnet, optimism, sepolia, type Chain } from 'viem/chains';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

export const SEPOLIA_CHAIN_ID_HEX = '0xaa36a7';

export function loadDevAccount(): PrivateKeyAccount {
  const pk = process.env.DEV_PK;
  if (!pk) throw new Error('DEV_PK missing from .env (renamed from EXPO_PUBLIC_DEV_PK — a private key must never carry the EXPO_PUBLIC_ prefix)');
  return privateKeyToAccount(`0x${pk.replace(/^0x/, '')}` as `0x${string}`);
}

export function rpcUrl(): string {
  const key = process.env.EXPO_PUBLIC_ALCHEMY_KEY;
  if (!key) {
    if (process.env.EXPO_PUBLIC_RPC_URL) return process.env.EXPO_PUBLIC_RPC_URL;
    throw new Error('Set EXPO_PUBLIC_ALCHEMY_KEY or EXPO_PUBLIC_RPC_URL');
  }
  return `https://eth-sepolia.g.alchemy.com/v2/${key}`;
}

/**
 * The chains this wallet can read and send on, by numeric id.
 *
 * It used to know one network. Reads were forwarded to the Sepolia RPC and
 * sends were signed for Sepolia whatever chain the page had switched to, which
 * is harmless while every e2e run is on Sepolia and wrong the moment one is
 * not: after a switch to OP the page would read Sepolia state and the wallet
 * would broadcast there. Each chain now has its own RPC, and a send is signed
 * for the chain the page is on. Sepolia stays the default, so the existing
 * journey is unchanged. The cross-chain swap run is the first caller of the rest.
 */
const WALLET_CHAINS: Record<number, { chain: Chain; alchemy: string }> = {
  [sepolia.id]: { chain: sepolia, alchemy: 'eth-sepolia' },
  [mainnet.id]: { chain: mainnet, alchemy: 'eth-mainnet' },
  [optimism.id]: { chain: optimism, alchemy: 'opt-mainnet' },
  [bsc.id]: { chain: bsc, alchemy: 'bnb-mainnet' },
  [base.id]: { chain: base, alchemy: 'base-mainnet' },
};

export function rpcUrlForChain(chainId: number): string {
  if (chainId === sepolia.id) return rpcUrl();
  const entry = WALLET_CHAINS[chainId];
  const key = process.env.EXPO_PUBLIC_ALCHEMY_KEY;
  if (!entry || !key) throw new Error(`The test wallet has no RPC for chain ${chainId}`);
  return `https://${entry.alchemy}.g.alchemy.com/v2/${key}`;
}

function chainRpcMap(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of Object.keys(WALLET_CHAINS)) {
    try { out[`0x${Number(id).toString(16)}`] = rpcUrlForChain(Number(id)); } catch { /* no key for it */ }
  }
  return out;
}

export async function installEvmWallet(
  page: Page,
  account: PrivateKeyAccount,
  opts: { liveSend?: boolean; onSend?: (hash: `0x${string}`) => void } = {},
): Promise<void> {
  const liveSend = opts.liveSend === true;
  if (liveSend) {
    // Node-side signing and broadcast, so the key still never enters the page.
    // The dapp hands us hex quantities; viem wants bigints. Gas fields are
    // passed through only when present, letting viem estimate otherwise.
    // One client per chain, created on first use, so a send is signed for and
    // broadcast to the chain the page is on rather than always Sepolia.
    const wallets = new Map<number, ReturnType<typeof createWalletClient>>();
    const walletFor = (chainId: number) => {
      let w = wallets.get(chainId);
      if (!w) {
        const entry = WALLET_CHAINS[chainId];
        if (!entry) throw new Error(`The test wallet cannot send on chain ${chainId}`);
        w = createWalletClient({ account, chain: entry.chain, transport: http(rpcUrlForChain(chainId)) });
        wallets.set(chainId, w);
      }
      return w;
    };
    await page.exposeFunction('__hwEvmSendTransaction', async (json: string, chainIdHex?: string) => {
      const tx = JSON.parse(json) as Record<string, string | undefined>;
      const big = (v?: string) => (v === undefined || v === null ? undefined : BigInt(v));
      const chainId = chainIdHex ? parseInt(chainIdHex, 16) : sepolia.id;
      const wallet = walletFor(chainId);
      const request = {
        account,
        chain: WALLET_CHAINS[chainId]!.chain,
        to: (tx.to ?? undefined) as `0x${string}` | undefined,
        data: (tx.data ?? undefined) as `0x${string}` | undefined,
        value: big(tx.value),
        maxFeePerGas: big(tx.maxFeePerGas),
        maxPriorityFeePerGas: big(tx.maxPriorityFeePerGas),
      };
      // A real wallet pads its estimate. viem's bare estimate has no headroom,
      // so a deposit landing after another one in the same block (a deeper
      // tree insert) ran out of gas (e2e run 38262152639).
      let gas = big(tx.gas ?? tx.gasLimit);
      if (gas === undefined) {
        const prepared = await wallet.prepareTransactionRequest({ ...request, parameters: ['gas'] });
        gas = (prepared.gas * 125n) / 100n;
      }
      const hash = await wallet.sendTransaction({ ...request, gas });
      console.log(`  [evm-wallet] eth_sendTransaction BROADCAST ${hash} on chain ${chainId}`);
      opts.onSend?.(hash);
      return hash;
    });
  }
  await page.exposeFunction('__hwEvmSignMessage', async (hexMessage: string) => {
    const sig = await account.signMessage({ message: { raw: hexMessage as `0x${string}` } });
    console.log('  [evm-wallet] personal_sign OK');
    return sig;
  });
  await page.exposeFunction('__hwEvmSignTypedData', async (json: string) => {
    const typed = JSON.parse(json) as Parameters<PrivateKeyAccount['signTypedData']>[0];
    const sig = await account.signTypedData(typed);
    console.log('  [evm-wallet] signTypedData OK');
    return sig;
  });

  const init = `(() => {
    const LIVE_SEND = ${JSON.stringify(liveSend)};
    let ADDRESS = ${JSON.stringify(account.address.toLowerCase())};
    // Test hook: swap the reported account mid-session, like a real
    // extension's account switcher (emits accountsChanged).
    window.__hwEvmSwitchAddress = (next) => {
      ADDRESS = String(next).toLowerCase();
      emit('accountsChanged', [ADDRESS]);
      console.log('  [evm-wallet] switched account to ' + ADDRESS);
    };
    // Test hook: the user disconnects the site from inside the wallet, which an
    // extension reports as an empty accountsChanged.
    window.__hwEvmDisconnect = () => {
      emit('accountsChanged', []);
      console.log('  [evm-wallet] disconnected from the wallet side');
    };
    let CHAIN_ID = window.__hwInitialChainId || ${JSON.stringify(SEPOLIA_CHAIN_ID_HEX)};
    const RPC_URL = ${JSON.stringify(rpcUrl())};
    // Reads go to the RPC of the chain the page is currently on.
    const RPC_BY_CHAIN = ${JSON.stringify(chainRpcMap())};
    let rpcId = 1;

    const listeners = {};
    const on = (event, fn) => { (listeners[event] = listeners[event] || []).push(fn); };
    const off = (event, fn) => { listeners[event] = (listeners[event] || []).filter((l) => l !== fn); };
    const emit = (event, payload) => { for (const fn of listeners[event] || []) { try { fn(payload); } catch {} } };

    async function rpcForward(method, params) {
      // No RPC for this chain is an error, not Sepolia: a quiet fallback would
      // serve Sepolia state for another chain (review of #133).
      const rpcUrl = RPC_BY_CHAIN[String(CHAIN_ID).toLowerCase()];
      if (!rpcUrl) throw Object.assign(new Error('evm-wallet: no RPC configured for chain ' + CHAIN_ID), { code: 4901 });
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
      });
      const json = await res.json();
      if (json.error) { const e = new Error(json.error.message); e.code = json.error.code; throw e; }
      return json.result;
    }

    const provider = {
      isHeadlessTestWallet: true,
      async request({ method, params }) {
        switch (method) {
          case 'eth_requestAccounts':
          case 'eth_accounts':
            return [ADDRESS];
          case 'eth_chainId':
            return CHAIN_ID;
          case 'net_version':
            return String(parseInt(CHAIN_ID, 16));
          case 'personal_sign': {
            // params: [hexMessage, address]
            return await window.__hwEvmSignMessage(params[0]);
          }
          case 'eth_signTypedData_v4':
          case 'eth_signTypedData': {
            // params: [address, typedDataJson]
            return await window.__hwEvmSignTypedData(params[1]);
          }
          case 'wallet_switchEthereumChain': {
            const next = params?.[0]?.chainId;
            if (typeof next === 'string' && next !== CHAIN_ID) {
              CHAIN_ID = next;
              console.log('  [evm-wallet] switched chain to ' + next);
              emit('chainChanged', CHAIN_ID);
            }
            return null;
          }
          case 'wallet_requestPermissions':
          case 'wallet_getPermissions':
            return [{ parentCapability: 'eth_accounts' }];
          case 'wallet_getCapabilities':
            return {};
          case 'eth_sendTransaction': {
            if (!LIVE_SEND) {
              const err = new Error('Headless capture wallet refuses to send transactions');
              err.code = 4001;
              throw err;
            }
            return await window.__hwEvmSendTransaction(JSON.stringify(params?.[0] ?? {}), CHAIN_ID);
          }
          case 'eth_sendRawTransaction': {
            const err = new Error('Headless capture wallet refuses to send transactions');
            err.code = 4001;
            throw err;
          }
          default:
            return await rpcForward(method, params ?? []);
        }
      },
      on,
      once: (event, fn) => { const wrap = (p) => { off(event, wrap); fn(p); }; on(event, wrap); },
      removeListener: off,
      removeAllListeners: (event) => { if (event) listeners[event] = []; },
      emit,
    };

    const ICON = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#19B091"/></svg>');
    const detail = Object.freeze({
      info: Object.freeze({
        uuid: '4b1cbe4e-8e30-4f7a-9a5a-000000006963',
        name: 'Headless Test Wallet',
        icon: ICON,
        rdns: 'io.0xbow.headless-test',
      }),
      provider,
    });
    const announce = () => {
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
    };
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
    // Legacy injected fallback for the generic injected() connector.
    try { window.ethereum = provider; } catch {}
    window.__EVM_WALLET_READY = true;
  })();`;

  await page.addInitScript(init);
}
