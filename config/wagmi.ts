import { createConfig, fallback, type State } from 'wagmi';
import { policedHttp } from '@/services/egress-transport';
import { VIEM_CHAIN_BY_ID } from '@/config/wagmi-chain-map';
import { injected, walletConnect } from 'wagmi/connectors';
import { getChainConfig, getDefaultChainConfig, supportedEvmChainIds } from '@/config/chains';

// Base wagmi config used by TypeScript for type-checking.
// At runtime, Metro resolves wagmi.native.ts or wagmi.web.ts instead.
// Web supplies the persisted account; native retains its existing startup.
export const initialState: State | undefined = undefined;

const projectId = process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID ?? '';

const connectors = projectId
  ? [injected(), walletConnect({ projectId })]
  : [injected()];

import type { Chain } from 'viem';
import { blockTimeByChain } from '@/services/chain-block-time';

const defaultChain = getDefaultChainConfig();

// createConfig demands a non-empty Chain tuple via `readonly [Chain, ...Chain[]]`.
// Cast each branch's first element so the tuple type stays the
// non-empty form without narrowing chain IDs to a literal union (which
// would break `switchChainAsync({ chainId: number })` call sites).
// Mirror the app's enabled EVM chain set exactly (chains.ts is the single
// source of truth) — see config/wagmi.web.ts for the full rationale.
const chains = supportedEvmChainIds
  .map((id) => VIEM_CHAIN_BY_ID[id])
  .filter((c): c is Chain => !!c) as unknown as readonly [Chain, ...Chain[]];
// Alchemy first, with any other configured endpoint behind it: viem's
// `fallback` rolls over on a failing or rate-limiting primary instead of
// failing the call. config/env.ts owns the ordering.
const transports: Record<number, ReturnType<typeof fallback>> = Object.fromEntries(
  chains.map((c) => [
    c.id,
    fallback(
      // App-owned public reads use the policy. Injected/WalletConnect
      // providers are separate transports controlled by the connected wallet.
      (getChainConfig(c.id)?.rpcUrls ?? defaultChain.rpcUrls).map((url) => policedHttp(url)),
    ),
  ]),
);

export const config = createConfig({
  chains,
  connectors,
  transports,
  // getBlockNumber reuse window = one block per chain (viem default: 4s).
  // Watchers such as receipt waits bypass it.
  cacheTime: blockTimeByChain(chains.map((c) => c.id)),
});

declare module 'wagmi' {
  interface Register {
    config: typeof config;
  }
}
