import { createConfig, fallback } from 'wagmi';
import { readWalletInitialState } from '@/services/wallet-initial-state';
import { policedHttp } from '@/services/egress-transport';
import { VIEM_CHAIN_BY_ID } from '@/config/wagmi-chain-map';
import type { Chain } from 'viem';
import { injected, walletConnect } from 'wagmi/connectors';
import { getChainConfig, getDefaultChainConfig, supportedEvmChainIds } from '@/config/chains';
import { smartWalletActive } from '@/config/smart-wallet';
import { makeEmbeddedConnector } from '@/config/embedded';
import { EMBEDDED_CONNECTOR_ID } from '@/services/embedded-wallet';
import { blockTimeByChain } from '@/services/chain-block-time';

// wagmi's walletConnect connector loads the provider via a dynamic
// `import('@walletconnect/ethereum-provider')` (a webpack optional-peer
// pattern). Under Metro/Expo Web that gets split into an async chunk
// that isn't reliably served, surfacing as
//   "Requiring unknown module '4530'. ... try restarting Metro."
// Static-importing the package here forces Metro to include it in the
// main bundle, so the dynamic import inside wagmi resolves to the
// already-loaded module instead of fetching a missing chunk. Only
// pulled in when EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID is set so users
// without WalletConnect configured pay no bundle cost.
const projectId = (process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID ?? '').trim();
const walletConnectEnabled =
  process.env.EXPO_PUBLIC_ENABLE_WALLETCONNECT_WEB === 'true' && projectId.length > 0;

// Only force-bundle the WalletConnect provider in dev. wagmi loads it
// via `await import(...)`, which Metro splits into an async chunk;
// the dev server doesn't always serve that chunk, surfacing as the
// "Requiring unknown module '4530'" runtime error. The static require
// pulls it into the main bundle so the dynamic import resolves
// instantly. In prod this require would also drag in the full
// @walletconnect/* tree (incl. a w3m-modal lazy chunk) — which made
// Vercel's deploy pipeline hang past 20+ minutes on every push.
// `__DEV__` is replaced + DCE'd at build time, so prod bundles ship
// without the require. wagmi's lazy import path handles WC at runtime
// in prod the way it normally would.
if (__DEV__ && walletConnectEnabled) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  require('@walletconnect/ethereum-provider');
}

// `injected()` covers the legacy `window.ethereum` case for wallets
// that don't announce via EIP-6963. wagmi's `multiInjectedProviderDiscovery`
// (default true, set explicitly below) auto-adds a separate connector
// per EIP-6963-announced wallet (MetaMask, Rabby, …) on top of this.
//
// `walletConnect({ showQrModal: false })`: skip wagmi's built-in QR
// modal entirely so we don't need to install @reown/appkit. The
// connector instead emits a 'message' event with `{ type: 'display_uri',
// data: '<wc uri>' }` which our wallet-connect-modal-provider catches
// and renders via react-native-qrcode-svg. Per wagmi docs:
// https://wagmi.sh/react/api/connectors/walletConnect#showqrmodal
// When the embedded smart wallet is active (web only when the flag is set), it
// goes first so it's the default "create wallet, no seedphrase" onboarding.
// injected()/walletConnect() remain for "connect existing wallet".
const externalConnectors = walletConnectEnabled
  ? [injected(), walletConnect({ projectId, showQrModal: false })]
  : [injected()];
const connectors = smartWalletActive()
  ? [makeEmbeddedConnector(), ...externalConnectors]
  : externalConnectors;

// wagmi mirrors the app's enabled EVM chain set exactly (chains.ts is the
// single source of truth): Sepolia alone on the normal build; with the
// staging deployments enabled, the staging chains join it, each on its own
// transport. An unmapped id would mean a chain the selector offers but wagmi
// can't switch to — VIEM_CHAIN_BY_ID (config/wagmi-chain-map.ts, shared by
// all three wagmi configs and invariant-tested) must cover every registrable id.
const defaultChain = getDefaultChainConfig();
const activeChains = supportedEvmChainIds
  .map((id) => VIEM_CHAIN_BY_ID[id])
  .filter((c): c is Chain => !!c) as unknown as readonly [Chain, ...Chain[]];
// Alchemy first, with any other configured endpoint behind it: viem's
// `fallback` rolls over on a failing or rate-limiting primary instead of
// failing the call. config/env.ts owns the ordering.
const transports = Object.fromEntries(
  activeChains.map((c) => [
    c.id,
    fallback(
      // App-owned public reads use the policy. Injected/WalletConnect
      // providers are separate transports controlled by the connected wallet.
      (getChainConfig(c.id)?.rpcUrls ?? defaultChain.rpcUrls).map((url) => policedHttp(url)),
    ),
  ]),
);

/**
 * Forget a saved connection whose connector this build does not register.
 *
 * wagmi restores connections from localStorage by connector id and, when the id
 * is not registered, the restored entry carries no methods: the first call into
 * it throws "connection.connector.getChainId is not a function", which surfaced
 * in the unlock dialog as "Key initialization failed" and survived reconnecting,
 * because the poisoned entry was in storage rather than in memory. It only
 * appeared after the embedded-wallet work, since that connector is the one whose
 * registration is flag-gated (smartWalletActive) and so can vanish between
 * builds while its saved connection remains.
 *
 * Scoped deliberately to the embedded id. Dropping every connection whose id is
 * absent from `connectors` would log out ordinary users: EIP-6963 wallets are
 * discovered at runtime, so their ids (io.metamask and friends) are never in the
 * static list.
 */
function forgetUnregisteredConnection(): void {
  if (typeof window === 'undefined') return;
  // Only ids whose REGISTRATION is build-gated, and only when this build does not
  // register them. WalletConnect joins the embedded connector here: it needs a
  // project id, so a build without one cannot restore a saved WalletConnect
  // session either.
  const gated = [
    connectors.some((c) => 'id' in c && c.id === EMBEDDED_CONNECTOR_ID) ? null : EMBEDDED_CONNECTOR_ID,
    walletConnectEnabled ? null : 'walletConnect',
  ].filter((id): id is string => !!id);
  if (gated.length === 0) return;
  try {
    const raw = window.localStorage.getItem('wagmi.store');
    const stale = gated.find((id) => raw?.includes(`"${id}"`));
    if (stale) {
      window.localStorage.removeItem('wagmi.store');
      console.log(`[PrivacyPools] cleared a saved "${stale}" connection: this build does not register that connector`);
    }
    const recent = window.localStorage.getItem('wagmi.recentConnectorId');
    if (recent && gated.some((id) => recent.includes(id))) {
      window.localStorage.removeItem('wagmi.recentConnectorId');
    }
  } catch {
    // A storage blob we cannot read is itself a reason to leave it alone.
  }
}

forgetUnregisteredConnection();

// Capture before createConfig initializes its store. Supply the saved account
// to Hydrate so the first render already has Wagmi's reconnecting identity.
export const initialState = typeof window === 'undefined' ? undefined
  : readWalletInitialState(key => window.localStorage.getItem(key));

export const config = createConfig({
  // Defer storage hydration and reconnect to WagmiProvider's mount effect.
  // Without this, wagmi's Hydrate reconnects during every render, updating
  // wallet subscribers while navigation is still rendering.
  ssr: true,
  chains: activeChains,
  connectors,
  transports,
  // getBlockNumber reuse window = one block per chain (viem default: 4s).
  // Watchers such as receipt waits bypass it.
  cacheTime: blockTimeByChain(activeChains.map((c) => c.id)),
  // Default is true; pinning explicitly so any future wagmi default
  // change can't silently regress the EIP-6963 wallet picker.
  multiInjectedProviderDiscovery: true,
});
