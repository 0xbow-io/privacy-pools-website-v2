// The connected wallet's holdings, fetched for the APP's lifetime rather than
// for whichever screen currently mounts a reader.
//
// hooks/use-wallet-tokens.ts used to run its `useQuery`/`useQueries` directly
// inside components/home/action-hub.tsx. TanStack Query only keeps a query's
// `refetchInterval` timer running while at least one observer (a mounted
// component) is subscribed to it — so navigating off the home screen (or a
// pool page) unsubscribed the ONLY reader, the interval stopped, and it
// restarted from zero on remount. For a chain read through the user's own
// RPC (services/wallet-tokens-onchain.ts) that is a real signal: a request
// gap that starts exactly when ActionHub unmounts and ends exactly when it
// remounts tells that RPC operator when this client is navigating (codex
// P2). Mounting the query here instead — a provider that lives for the whole
// session, next to components/pools-provider.tsx's identical fixed-cadence
// reads — keeps the timer running whether or not anything is currently
// reading its data.
import { createContext, useCallback, useContext, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useAccount } from 'wagmi';

import { getChainConfig } from '@/config/chains';
import { feedLifiVerifiedTokens } from '@/services/lifi-token-list';
import { EMPTY_FEED_STATE, feedData, publicFeeds, type FeedState } from '@/services/public-feed-scheduler';
import {
  ALCHEMY_WALLET_CHAIN_IDS,
  fetchWalletTokensByChain,
  markSuspiciousTokens,
  ONCHAIN_WALLET_CHAIN_IDS,
  WALLET_TOKEN_MAINNET_IDS,
  type WalletToken,
} from '@/services/wallet-tokens';
import { fetchWalletTokensOnChain } from '@/services/wallet-tokens-onchain';

/**
 * Fixed cadence, keyed only on the address: it neither speeds up nor pauses
 * for anything the user does in the app. Picks up tokens that arrive after
 * connect and recovers from a failed first read.
 */
const WALLET_TOKENS_INTERVAL_MS = 5 * 60_000;

const EMPTY: WalletToken[] = [];

// Stable at module scope, so useQueries hands back the same array until a result changes.
const dataOnly = (results: { data?: WalletToken[] }[]) => results.map((r) => r.data);

type VerifiedStates = readonly FeedState<Set<string>>[];

function useVerifiedTokenFeeds(): VerifiedStates {
  const last = useRef<VerifiedStates>(WALLET_TOKEN_MAINNET_IDS.map(() => EMPTY_FEED_STATE));
  const subscribe = useCallback((onChange: () => void) => {
    const offs = WALLET_TOKEN_MAINNET_IDS.map((id) => publicFeeds.subscribe(feedLifiVerifiedTokens(id), onChange));
    return () => { for (const off of offs) off(); };
  }, []);
  // One array per change, so the snapshot stays referentially stable between updates.
  const getSnapshot = useCallback(() => {
    const next = WALLET_TOKEN_MAINNET_IDS.map((id) => publicFeeds.read<Set<string>>(feedLifiVerifiedTokens(id)));
    if (next.every((state, i) => state === last.current[i])) return last.current;
    last.current = next;
    return next;
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

type WalletTokensLookup = (chainId: number) => WalletToken[];

const noTokens: WalletTokensLookup = () => EMPTY;
const WalletTokensContext = createContext<WalletTokensLookup>(noTokens);

/**
 * Mounted once, at the app root (app/_layout.tsx), next to PoolsProvider —
 * NOT inside a screen. The connected wallet's holdings on every chain this
 * build lists wallet tokens for, with scams marked. A chain on the user's own
 * RPC is read on-chain through it instead, once LiFi's list for it is in
 * hand. The chain being looked at never changes what is fetched or when: one
 * request covers every chain, when a wallet is connected and then on a fixed
 * cadence that keeps running regardless of which screen (if any) is reading it.
 */
export function WalletTokensProvider({ children }: { children: ReactNode }) {
  const { address: owner } = useAccount();
  const { data } = useQuery({
    queryKey: ['wallet-tokens', owner?.toLowerCase()],
    enabled: !!owner && ALCHEMY_WALLET_CHAIN_IDS.length > 0,
    queryFn: ({ signal }) => fetchWalletTokensByChain(owner!, ALCHEMY_WALLET_CHAIN_IDS, signal),
    // Balances on the visible rows are read on-chain by the sheet, so this
    // list mostly decides which tokens get a row; it need not be fast.
    refetchInterval: WALLET_TOKENS_INTERVAL_MS,
    refetchIntervalInBackground: true,
    staleTime: WALLET_TOKENS_INTERVAL_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    retry: 1,
  });
  const verifiedStates = useVerifiedTokenFeeds();
  const verifiedOn = useCallback((chainId: number) => {
    const feedIndex = WALLET_TOKEN_MAINNET_IDS.indexOf(chainId);
    return feedIndex >= 0 ? feedData(verifiedStates[feedIndex]) ?? null : null;
  }, [verifiedStates]);
  const onChainData = useQueries({
    queries: ONCHAIN_WALLET_CHAIN_IDS.map((chainId) => ({
      queryKey: ['wallet-tokens-onchain', owner?.toLowerCase(), chainId],
      // Waits for the list, since it IS the call set; a later list is picked
      // up by the next tick, not by a refetch of its own.
      enabled: !!owner && !!verifiedOn(chainId),
      // The chain record's endpoint IS the user's (config/chains applies the override).
      queryFn: () => fetchWalletTokensOnChain(owner!, chainId, getChainConfig(chainId)!.rpcUrl, verifiedOn(chainId)!),
      refetchInterval: WALLET_TOKENS_INTERVAL_MS,
      refetchIntervalInBackground: true,
      staleTime: WALLET_TOKENS_INTERVAL_MS,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      retry: 1,
    })),
    combine: dataOnly,
  });
  const marked = useMemo(() => {
    const byChain: Record<number, WalletToken[]> = { ...(data ?? {}) };
    ONCHAIN_WALLET_CHAIN_IDS.forEach((chainId, i) => {
      const tokens = onChainData[i];
      if (tokens) byChain[chainId] = tokens;
    });
    const out: Record<number, WalletToken[]> = {};
    for (const [id, tokens] of Object.entries(byChain)) {
      const chainId = Number(id);
      out[chainId] = markSuspiciousTokens(tokens, chainId, verifiedOn(chainId));
    }
    return out;
  }, [data, verifiedOn, onChainData]);
  const tokensFor = useCallback((chainId: number) => marked[chainId] ?? EMPTY, [marked]);
  return <WalletTokensContext.Provider value={tokensFor}>{children}</WalletTokensContext.Provider>;
}

/**
 * The connected wallet's holdings, by chain. Reads the provider above rather
 * than running its own query, so no screen's mount/unmount can start or stop
 * the underlying poll (see the file header).
 */
export function useWalletTokens(): WalletTokensLookup {
  return useContext(WalletTokensContext);
}
