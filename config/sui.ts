/**
 * Sui network configuration.
 *
 * ONE place decides which Sui network the app talks to: `EXPO_PUBLIC_SUI_NETWORK`.
 * The RPC URL, the dapp-kit client (components/sui-provider.tsx) and the
 * advertised chain id (`ACTIVE_SUI_CHAIN_ID` in config/chains.ts) all follow
 * from `ACTIVE_SUI_NETWORK`, so they can never disagree.
 *
 * Mainnet is NOT usable yet and this module refuses to build one — see the
 * throw below. Setting the flag is necessary but far from sufficient. Checklist
 * before mainnet can be enabled:
 *
 *   1. `SUI_MAINNET_CONTRACTS` + a mainnet `GlobalViewKey` in
 *      config/sui-deployment.ts, attached to the `SUI_MAINNET_ID` entry in
 *      config/chains.ts (today that entry has no `suiContracts`, so every
 *      protocol action fails closed).
 *   2. Replace the hardcoded testnet chain id in the live Sui paths with
 *      `ACTIVE_SUI_CHAIN_ID`: components/chain-provider.tsx (wallet
 *      auto-connect), components/pools/pool-page-content.tsx (Sui pool route),
 *      components/pools-provider.tsx (Sui-vs-EVM note/asset classification —
 *      getting this wrong shows EVM assets on a Sui chain), and
 *      components/payment-request-modal-provider.tsx. Prefer
 *      `getChainConfig(id)?.chainType === 'sui'` over an id equality check.
 *   3. Namespace the persisted Sui note store by network. services/sui-witness/
 *      note-store.ts keys notes by owner address ONLY, so a mainnet build would
 *      surface the account's testnet notes as a mainnet balance and offer them
 *      to transfer/withdraw/ragequit. Migrate the existing address-only
 *      namespace explicitly into the testnet namespace.
 *   4. Set `EXPO_PUBLIC_SUI_MAINNET_RPC_URL` (or rely on Alchemy). The legacy
 *      `EXPO_PUBLIC_SUI_RPC_URL` is testnet-scoped and will NOT feed mainnet.
 *
 * Then delete the guard below in the same change.
 */
import { SUI_MAINNET_RPC_URL, SUI_NETWORK, SUI_TESTNET_RPC_URL } from '@/config/env';

export const SUI_NETWORKS = {
  testnet: {
    url: SUI_TESTNET_RPC_URL,
  },
  mainnet: {
    url: SUI_MAINNET_RPC_URL,
  },
} as const;

export type SuiNetwork = keyof typeof SUI_NETWORKS;

/** The single Sui network this build talks to. Defaults to testnet. */
export const ACTIVE_SUI_NETWORK: SuiNetwork = SUI_NETWORK;

// Fail closed, loudly. Selecting mainnet today yields a build that ADVERTISES
// Sui mainnet (chain 101) while the live paths listed above still act on testnet
// (102), and that would read the address-keyed note store as if those testnet
// notes existed on mainnet. Every protocol action would fail anyway, since
// mainnet carries no contracts. `EXPO_PUBLIC_*` is baked in at build time, so
// this trips during build/boot for whoever set it — never silently in a user's
// browser. env.ts already throws for a missing EXPO_PUBLIC_ASP_URL; same idea.
if (ACTIVE_SUI_NETWORK === 'mainnet') {
  throw new Error(
    'EXPO_PUBLIC_SUI_NETWORK=mainnet is not supported yet. Sui mainnet has no ' +
      'deployed contracts (SUI_MAINNET_ID carries no suiContracts/globalViewKey), ' +
      'several live paths still hardcode the testnet chain id, and the Sui note ' +
      'store is not namespaced by network. See the checklist at the top of ' +
      'config/sui.ts before enabling it.',
  );
}

/** RPC endpoint for {@link ACTIVE_SUI_NETWORK}. */
export const ACTIVE_SUI_RPC_URL: string = SUI_NETWORKS[ACTIVE_SUI_NETWORK].url;
