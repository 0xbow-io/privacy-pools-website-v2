/**
 * Chain provider - holds the app-wide selected chain so the header selector,
 * routing hooks, and modals all agree on which chain (EVM vs Sui) is active.
 *
 * Without this, useChainRouter held component-local state and selections made
 * in the header would not propagate to deposit/transact/ragequit flows.
 *
 * The SELECTION is the single routing truth (wallet hooks and modals derive
 * their EVM/Sui branch from it). To keep it in sync with the wallet without
 * overriding the user, a Sui wallet CONNECT auto-selects the Sui chain and a
 * DISCONNECT falls back to the EVM default — but only on those transitions;
 * an explicit selection made while connected is respected.
 */
import React, { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { useAccount, useChainId, useSwitchChain } from 'wagmi';
import { defaultChainId, getChainConfig, getPresetRpcUrls, homeChainId, isSupportedEvmChainId, STELLAR_OPT_IN, STELLAR_SELECTED_BY_URL, supportedChainIds, STELLAR_TESTNET_ID, SUI_TESTNET_ID } from '@/config/chains';
import { useStellarWallet } from '@/components/stellar-wallet-provider';
import { isDebugModeActive } from '@/components/debug-provider';
import { VIEM_CHAIN_BY_ID } from '@/config/wagmi-chain-map';
import { buildAddChainParameter } from '@/config/add-chain-parameter';
import { useWalletChainExcursionHome } from '@/hooks/use-wallet-chain-excursion';
import { cancelWalletChainExcursion } from '@/services/wallet-chain-excursion';

/** How a selectChain request ended — see the selectChain doc comment. */
export type ChainSelectOutcome = 'committed' | 'declined' | 'superseded';

/** See config/add-chain-parameter.ts — pure and tested there. */
function addChainParameterFor(chainId: number) {
  return buildAddChainParameter({
    viemChain: VIEM_CHAIN_BY_ID[chainId],
    displayName: getChainConfig(chainId)?.displayName,
    // getPresetRpcUrls, NOT the chain's live rpcUrls: this list leaves the app
    // for an external wallet (and through WalletConnect, its relay) and is
    // stored there. A custom endpoint the user set is theirs and often carries
    // their API key, so it is deliberately not offered here.
    configuredRpcUrls: getPresetRpcUrls(chainId),
  });
}

interface ChainContextValue {
  selectedChainId: number;
  selectChain: (chainId: number) => Promise<ChainSelectOutcome>;
}

const ChainContext = createContext<ChainContextValue | null>(null);

export function ChainProvider({ children }: { children: React.ReactNode }) {
  const suiAccount = useCurrentAccount();
  const stellarWallet = useStellarWallet();
  // ?stellar=true starts on Stellar (only where Stellar is served, see
  // STELLAR_SELECTED_BY_URL); otherwise the home chain.
  const [selectedChainId, setSelectedChainId] = useState<number>(() =>
    STELLAR_SELECTED_BY_URL && supportedChainIds.includes(STELLAR_TESTNET_ID) ? STELLAR_TESTNET_ID : homeChainId,
  );
  // Wagmi must follow EVM selections: the SDK session, deposits and every
  // wallet write key off wagmi's chain (useChainId), so a selector that only
  // changed display state would leave the wallet transacting on the previous
  // chain. Mainline builds carry one EVM chain, so this only ever fires on
  // the staging build (mainnet + Citrea behind one selector). Disconnected,
  // switchChain updates wagmi's store; connected, it prompts the wallet —
  // and the SELECTION only commits when the switch actually succeeds, so a
  // rejected prompt can never leave the app describing chain B while the
  // wallet (and therefore proofs) stay on chain A.
  const wagmiChainId = useChainId();
  const excursionHome = useWalletChainExcursionHome();
  const { switchChainAsync } = useSwitchChain();
  // Live connection mirror for selectChain's disconnected fast-path.
  const { isConnected: evmConnected } = useAccount();
  const connectedRef = useRef(evmConnected);
  connectedRef.current = evmConnected;
  // Monotonic token: a slow older switch resolving late must not overwrite a
  // newer selection.
  const switchReqRef = useRef(0);

  // Resolves 'committed' when the selection actually lands, 'declined' when
  // it is refused (unsupported id, gated Sui, or the wallet rejected the
  // switch), and 'superseded' when a NEWER selection overtook this one while
  // its wallet switch was pending — deep-link auto-actions key off the
  // distinction so only a real refusal disarms them (codex verification).
  // Fire-and-forget callers can ignore the value.
  const selectChain = useCallback(async (chainId: number): Promise<ChainSelectOutcome> => {
    // Only configured chains are selectable — an arbitrary id would silently
    // repoint chain-scoped queries (e.g. the ASP events feed) at a chain this
    // build has no deployment for.
    if (!supportedChainIds.includes(chainId)) {
      if (typeof console !== 'undefined') {
        console.warn(`[ChainProvider] Ignoring unsupported chain selection: ${chainId}`);
      }
      return 'declined';
    }
    // Sui is debug-gated on this build: the testnet-only Sui integration is
    // hidden from regular users and reachable only in debug mode (?debug=1 or
    // the persisted debug flag — see components/debug-provider.tsx).
    if (getChainConfig(chainId)?.chainType === 'sui' && !isDebugModeActive()) {
      if (typeof console !== 'undefined') {
        console.warn('[ChainProvider] Sui selection requires debug mode (?debug=1)');
      }
      return 'declined';
    }
    // Stellar testnet: debug gate or its own ?stellar=true opt-in.
    if (getChainConfig(chainId)?.chainType === 'stellar' && !STELLAR_OPT_IN && !isDebugModeActive()) {
      if (typeof console !== 'undefined') {
        console.warn('[ChainProvider] Stellar selection requires ?stellar=true or debug mode');
      }
      return 'declined';
    }
    // EVERY accepted selection advances the generation (codex verification):
    // bumping only inside the async branch let an older pending wallet switch
    // resolve late and overwrite a NEWER synchronous selection (Sui, or an
    // EVM chain the wallet was already on).
    const req = ++switchReqRef.current;
    // A chosen chain ends any wallet excursion still running (a registration
    // on another chain the user closed and walked away from), so its switch
    // back cannot later drag the wallet and the selection to the old home.
    // Only where the selection actually COMMITS: a pick the wallet declines,
    // or a newer pick supersedes, must leave a live excursion pinned, or the
    // app would drift to the chain the wallet is visiting.
    const commit = () => {
      cancelWalletChainExcursion();
      setSelectedChainId(chainId);
    };
    if (getChainConfig(chainId)?.chainType === 'evm' && chainId !== wagmiChainId) {
      // Describe the chain so a wallet that has never heard of it can ADD it
      // instead of failing the switch with 4902. This is what the staging
      // chains need: a fresh MetaMask ships with none of Citrea, BNB or
      // Optimism, so the selector moved the app while the wallet stayed put
      // (Pat, 2026-08-28).
      const addEthereumChainParameter = addChainParameterFor(chainId);
      // DISCONNECTED: there is no wallet to prompt and nothing to "decline" —
      // commit the selection directly (a store-switch failure here painted
      // spurious wrong-network warnings for signed-out /pay visitors). The
      // store follows best-effort; connected flows re-verify chains per-call.
      if (!connectedRef.current) {
        void switchChainAsync({ chainId, addEthereumChainParameter })
          .catch(() => { /* store-only sync; selection is the truth */ });
        commit();
        return 'committed';
      }
      try {
        await switchChainAsync({ chainId, addEthereumChainParameter });
        if (switchReqRef.current === req) {
          commit();
          return 'committed';
        }
        return 'superseded'; // a newer selection overtook this one
      } catch {
        // Rejected / unsupported by the connector: keep the previous
        // selection so data surfaces and proofs stay on the wallet's chain.
        return switchReqRef.current === req ? 'declined' : 'superseded';
      }
    }
    // Synchronous path: still current by construction (no await since the bump).
    commit();
    return 'committed';
  }, [wagmiChainId, switchChainAsync]);

  // Reconcile the selection FROM wagmi: a wallet that auto-connects on (or is
  // manually switched to) another SUPPORTED EVM chain must drag the app
  // selection with it — the SDK session and every write already follow wagmi,
  // and without this the data surfaces would describe a different chain than
  // the one the user is transacting on. Only EVM→EVM: an active Sui selection
  // is not disturbed by background wagmi state.
  //
  // Not during a wallet excursion (services/wallet-chain-excursion.ts): the
  // wallet is on another chain for one transaction and comes back before the
  // excursion ends, so the selection stays where the user put it.
  useEffect(() => {
    if (!evmConnected) return;
    if (excursionHome !== null) return;
    if (!isSupportedEvmChainId(wagmiChainId)) return; // SupportedChainGuard's job
    setSelectedChainId((current) => {
      const currentIsEvm = getChainConfig(current)?.chainType === 'evm';
      return currentIsEvm && current !== wagmiChainId ? wagmiChainId : current;
    });
  }, [evmConnected, wagmiChainId, excursionHome]);

  // Auto-select on Sui wallet connect/disconnect TRANSITIONS only. Starts as
  // null so an auto-connected wallet's first non-null account still counts as
  // a connect; selection changes made while connected never re-trigger this.
  const prevSuiAddressRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevSuiAddressRef.current;
    const curr = suiAccount?.address ?? null;
    if (prev === curr) return;
    prevSuiAddressRef.current = curr;
    const activeIsSui = getChainConfig(selectedChainId)?.chainType === 'sui';
    if (!prev && curr && !activeIsSui) {
      // Sui wallet connected while an EVM chain is active -> switch to Sui.
      // Debug-gated: without debug mode a connected Sui wallet extension must
      // not surface the (hidden) Sui integration to regular users.
      if (!isDebugModeActive()) return;
      // Builds that don't carry the Sui chain (the staging build) must not
      // auto-select an unsupported id — this write bypasses selectChain's
      // supported-chain guard.
      if (!supportedChainIds.includes(SUI_TESTNET_ID)) return;
      setSelectedChainId(SUI_TESTNET_ID);
    } else if (prev && !curr && activeIsSui) {
      // Sui wallet disconnected while Sui is active -> back to the EVM default.
      setSelectedChainId(defaultChainId);
    }
  }, [suiAccount?.address, selectedChainId]);

  // Same transition rule for the Stellar wallet (Freighter).
  const prevStellarAddressRef = useRef<string | null>(null);
  const stellarAddress = stellarWallet.isConnected ? stellarWallet.address : null;
  useEffect(() => {
    const prev = prevStellarAddressRef.current;
    const curr = stellarAddress;
    if (prev === curr) return;
    prevStellarAddressRef.current = curr;
    const activeIsStellar = getChainConfig(selectedChainId)?.chainType === 'stellar';
    if (!prev && curr && !activeIsStellar) {
      if (!STELLAR_OPT_IN && !isDebugModeActive()) return;
      if (!supportedChainIds.includes(STELLAR_TESTNET_ID)) return;
      // Advance the selection generation so a pending EVM wallet switch
      // cannot resolve late and overwrite this selection.
      ++switchReqRef.current;
      setSelectedChainId(STELLAR_TESTNET_ID);
    } else if (prev && !curr && activeIsStellar) {
      ++switchReqRef.current;
      setSelectedChainId(defaultChainId);
    }
  }, [stellarAddress, selectedChainId]);

  const value = useMemo<ChainContextValue>(
    () => ({ selectedChainId, selectChain }),
    [selectedChainId, selectChain],
  );

  return <ChainContext.Provider value={value}>{children}</ChainContext.Provider>;
}

/**
 * Read the shared chain selection. Returns null when no provider is mounted so
 * useChainRouter can fall back to local state (keeps non-wrapped usage working).
 */
export function useChainContext(): ChainContextValue | null {
  return useContext(ChainContext);
}
