/**
 * Sui wallet provider — wraps @mysten/dapp-kit for Sui chain support.
 */
import React from 'react';
import { Platform } from 'react-native';
import { SuiClientProvider, WalletProvider, createNetworkConfig } from '@mysten/dapp-kit';
import { JsonRpcHTTPTransport } from '@mysten/sui/jsonRpc';
import { ACTIVE_SUI_NETWORK, ACTIVE_SUI_RPC_URL } from '@/config/sui';
import { TOR_IN_FORCE } from '@/config/tor';
import { routedFetch } from '@/services/tor-fetch';
import { suiSubject } from '@/services/sui-tor-subject';

// Register ONLY the active Sui network. Keeping a single entry — together with
// the pinned default below — means a stray `selectNetwork('mainnet')` cannot
// silently route Sui txs to a network this build was not configured for; it
// simply has no such entry to resolve. Flipping EXPO_PUBLIC_SUI_NETWORK moves
// both the entry and the default together, so they can never disagree.
// The URL comes from config/sui so this client cannot drift from what
// config/chains.ts advertises (it used to hardcode the fullnode Sui retired).
// Under anon-rpc the fullnode is reached over the chain-read group, a call
// naming the user's account over that account's group, a transaction the
// wallet signed (executed or dry-run) over its signer's, and a transaction
// lookup over that transaction's.
const transport = TOR_IN_FORCE
  ? new JsonRpcHTTPTransport({ url: ACTIVE_SUI_RPC_URL, fetch: routedFetch('rpc', suiSubject) as typeof fetch })
  : undefined;

const { networkConfig } = createNetworkConfig({
  [ACTIVE_SUI_NETWORK]: transport ? { url: ACTIVE_SUI_RPC_URL, transport } : { url: ACTIVE_SUI_RPC_URL },
} as any);

export function SuiProvider({ children }: { children: React.ReactNode }) {
  // Pin the Sui client to the one configured Sui deployment. dapp-kit's
  // `useSignAndExecuteTransaction` signs for `sui:${defaultNetwork}` when no
  // explicit chain is passed, so this must match the single registered network
  // above. TEST_MODE governs the EVM network (sepolia vs mainnet) and must NOT
  // drive the Sui network — otherwise a production build (TEST_MODE=false)
  // would execute Sui txs on Sui mainnet, where no pool exists. Only
  // EXPO_PUBLIC_SUI_NETWORK moves it, and it defaults to testnet.
  const defaultNetwork = ACTIVE_SUI_NETWORK;

  return (
    <SuiClientProvider networks={networkConfig} defaultNetwork={defaultNetwork}>
      {/* theme null on native: the default theme injects a DOM <style> tag. */}
      <WalletProvider autoConnect theme={Platform.OS === 'web' ? undefined : null}>
        {children}
      </WalletProvider>
    </SuiClientProvider>
  );
}
