// RULE (Pat 2026-10-21): underlying is DISPLAY ONLY. All maths, MAX,
// amounts, validation, quotes, relayer and on-chain values stay in shares
// (exact strings/bigints). Never convert an amount to underlying and back,
// never feed a displayed underlying figure into an operation.
// Display headlines use underlying through shareBalanceDisplay; shares appear
// only in the (i) hint, in fields labelled with the share symbol, or while the
// rate is unknown. Never print a share count under the underlying symbol.
// Exception: Withdraw/Send edits cross shareAmountFromUnderlying once; untouched
// MAX retains the original exact shares. USD edits use an exact decimal price
// in that same boundary. No other operation converts display back.
import { useBalanceDisplay } from '@/hooks/use-balance-display';
import { ShareCountHint } from '@/components/pools/share-count-hint';
import { poolDisplayLabel } from '@/config/pool-paths';
import React, { useCallback, useMemo, useState } from 'react';
import { CloseIcon } from '@/components/ui/modal-icons';
import Ionicons from '@expo/vector-icons/Ionicons';
import { FlatList, Platform, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import type { ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useQuery } from '@tanstack/react-query';
import { useAccount, useConfig, useReadContract, useReadContracts } from 'wagmi';
import { getBalance } from 'wagmi/actions';
import { erc20Abi, formatUnits } from 'viem';
import type { Address as ViemAddress } from 'viem';
import { useCurrentAccount, useSuiClientQuery } from '@mysten/dapp-kit';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { ChainLogo, chainLogoChainFor } from '@/components/ui/chain-logo';
import { TokenNetworkIcon } from '@/components/ui/token-network-icon';
import { COMING_SOON_ASSET_SUBTITLE, displayTokenSymbol, isShareSymbol, LEGACY_ASSET_SUBTITLE, shareSubtitle, wrapsIntoShareSubtitle } from '@/services/share-display';
import { getKnownTokenMetadata } from '@/config/tokens';
import { getConfiguredDepositRouteForPayToken } from '@/config/yield';
import { useShareYield } from '@/hooks/use-share-yield';
import { formatApyPercent } from '@/services/share-yield';
import { getChainConfig, SUI_TESTNET_ID } from '@/config/chains';
import { holdingsChainName } from '@/services/wallet-tokens';
import { formatTokenBalance } from '@/config/tokens';
import { usePools } from '@/components/pools-provider';
import { intentSwapsEnabledForChain } from '@/config/intent-swaps';
import { useAllChainsPriceMap } from '@/hooks/use-all-chains-price-map';
import { priceFromMap } from '@/services/price-map-merge';
import { useBackHandler } from '@/hooks/use-back-handler';
import { splitNetworkChips } from '@/services/widget-chain-lists';

/**
 * Full-screen (narrow) / centered-card (desktop) token picker, Uniswap-shaped:
 * search, paste-any-address, and the balance each row is ABOUT — the wallet's
 * inventory when paying in, the shielded holding when spending out
 * (`balanceMode`). With no chain selected the list spans chains and every row
 * states its own.
 *
 * EVERY figure here is real — nothing is fabricated, and a value we cannot
 * source is rendered as "—" rather than a zero:
 *   - pool support      → the `tokens` prop, i.e. the caller's per-chain asset
 *                         config (deposit modal `availableTokens`).
 *   - swap route        → `intentSwapsEnabledForChain` (config/intent-swaps.ts,
 *                         flag + deployed RelaySwaps processor, fails closed) —
 *                         gates whether a non-pool asset is selectable at all.
 *   - native balance    → wagmi `getBalance`, once per chain a native row lives on.
 *   - ERC-20 balances   → wagmi `useReadContracts` multicall of `balanceOf`
 *                         (same pattern as components/pools-provider.tsx).
 *   - Sui balance       → dapp-kit `useSuiClientQuery('getBalance')` (same call
 *                         the deposit modal and the action hub make). Native
 *                         SUI only — see the note at `suiBalanceData` below.
 *   - USD prices        → services/price-service `getAllPrices()`, i.e. the ASP
 *                         `/global/public/token-prices` feed (+ the existing
 *                         Alchemy fallback for testnet zeros). Used only to
 *                         ORDER the rows now — a token with no price sorts
 *                         alphabetically. The USD figure is no longer shown:
 *                         it restated the balance above it in another unit,
 *                         where the shielded balance is what informs the pick.
 *   - shielded balance  → components/pools-provider `myPools`, the same source
 *                         every other surface reads, so the sheet cannot
 *                         disagree with the form behind it.
 *   - pasted address    → on-chain `symbol`/`name`/`decimals` via
 *                         `useReadContracts` + `erc20Abi`.
 *
 * Selection contract: `onSelectToken` only ever fires with an entry of the
 * `tokens` prop (matched by address), so a token the pool does not accept can
 * never reach the caller's money path. Non-pool tokens are shown for
 * transparency (with their route) but are not selectable.
 */

// react-native-web supports position:'fixed', absent from RN's ViewStyle.
// Native has no 'fixed' — fall back to an absolute full-screen overlay.
interface WebOnlyViewStyle { position?: string }
const OVERLAY_POSITION: ViewStyle & WebOnlyViewStyle = Platform.OS === 'web'
  ? { position: 'fixed' } as ViewStyle & WebOnlyViewStyle
  : { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 };

/** 0x + 40 hex — "the query looks like an address". Checksum-agnostic. */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * The one subtitle that outranks every other: a pool that cannot be deposited
 * into yet must say so, not describe the yield it will one day earn.
 */
function comingSoonSubtitle(row: { comingSoon: boolean }): string | null {
  return row.comingSoon ? COMING_SOON_ASSET_SUBTITLE : null;
}

export interface TokenSelectSheetToken {
  symbol: string;
  address: string;
  decimals: number;
  isNative?: boolean;
  /** Human name shown under the symbol (e.g. "USD Coin"). */
  name?: string;
  /** Remote logo for a token without hand-drawn artwork (see TokenNetworkIcon). */
  logoUrl?: string;
  /**
   * Chain this entry belongs to. Required when the caller lists tokens from
   * SEVERAL chains at once (no network selected — "all chains"); with a single
   * network selected it defaults to the sheet's `chainId`.
   */
  chainId?: number;
  /**
   * Unknown or scam-shaped (services/token-spam-filter): hidden behind an
   * explicit reveal at the end of the list instead of being dropped, so a false
   * positive is never a dead end.
   */
  suspicious?: boolean;
  /**
   * The caller's own reading of the wallet balance (Alchemy's, for wallet
   * rows). Shown for SUSPICIOUS rows until the reveal is opened and their
   * on-chain read lands: an airdrop wallet holds hundreds of them, so they are
   * not read while hidden.
   */
  walletBalance?: number;
  /**
   * The pool for this asset has not opened yet (config `depositComingSoon`,
   * mainnet ETH). Listed but NOT selectable, with an "Available soon" line:
   * dropping the row instead would answer "we do not support ETH", which is
   * not what is true.
   */
  comingSoon?: boolean;
  /**
   * A pool asset on its chain (the caller's catalog row), as opposed to a
   * token the wallet happens to hold. With `hideZeroBalances` the pay sheet
   * lists the wallet's holdings first and then every pool asset it does not
   * hold, so the picker always answers "what can I shield here" even from an
   * empty or disconnected wallet (Mike, 2026-09-18).
   */
  poolAsset?: boolean;
  /**
   * A holding on a chain with no pool in this build (DEV-521). Listed with
   * the caller's `walletBalance` / `walletUsdValue` (the app-wide wallet
   * poll), never read on-chain from here, and not selectable: this line says
   * why instead.
   */
  unavailableReason?: string;
  /** USD value of `walletBalance`, for rows the sheet has no price for. */
  walletUsdValue?: number;
}

export interface TokenSelectSheetNetwork {
  id: number;
  name: string;
  /** Listed but not pickable here, with the short reason shown in the chip. */
  unavailableReason?: string;
}

type ListItem =
  | { kind: 'heading'; key: string; section: 'wallet' | 'pools' }
  | { kind: 'row'; key: string; row: TokenRow };

type TokenRow = {
  key: string;
  symbol: string;
  name?: string;
  logoUrl?: string;
  address: string;
  decimals: number;
  isNative: boolean;
  /** Chain this row's asset lives on (an all-chains list spans several). */
  chainId: number;
  /** Unknown / scam-shaped — revealed only on request. */
  suspicious: boolean;
  /** Pool not open yet — shown, never selectable. */
  comingSoon: boolean;
  /** Not selectable here, with the reason (see TokenSelectSheetToken). */
  unavailableReason?: string;
  /** undefined = not readable (no wallet / failed read) — never shown as 0. */
  balance?: number;
  /** undefined = no real price available — never fabricated. */
  usdValue?: number;
  /**
   * Already-shielded balance for this asset, preformatted. undefined when the
   * asset has none (or the pools data has not resolved) — never a fake 0.
   */
  privateBalance?: string;
  privateHint?: string | null;
  /** Directly depositable on the active chain (present in the pool config). */
  poolSupported: boolean;
  /** Resolved from a pasted address rather than the configured list. */
  custom: boolean;
  /** Catalog pool asset (see TokenSelectSheetToken.poolAsset). */
  poolAsset: boolean;
  /**
   * Which group of the pay sheet the row renders in: what the wallet holds,
   * or the pools it could shield into. Unset when the sheet is not grouped.
   */
  section?: 'wallet' | 'pools';
};

/**
 * The yield line under a share, or under the asset that wraps into one: the
 * LIVE net rate when the on-chain read has answered ("1.17% Aave yield"), the
 * caller's wording until then or when the read fails (Mike, 2026-09-18: the
 * picker said "Earns Aave yield" while the card beside it knew the figure).
 * A component, not a helper, because the read is a hook and the rows are a
 * list.
 */
function ShareYieldSubtitle({ chainId, shareAddress, fallback, suffix }: {
  chainId: number;
  shareAddress: string | undefined;
  fallback: string;
  suffix: string;
}) {
  const { yield: live } = useShareYield({ chainId, tokenAddress: shareAddress });
  return (
    <Text className="font-pp-regular text-[12px] text-text-muted" numberOfLines={1}>
      {(live ? `${formatApyPercent(live.netApyPercent)}% Aave yield` : fallback) + suffix}
    </Text>
  );
}


function CheckIcon({ color = '#00ACC4' }: { color?: string }) {
  return (
    // nw-keep(svg-or-canvas): stroke fed by the caller's color prop (selection check mark)
    <Svg width={18} height={18} viewBox="0 0 18 18" fill="none">
      <Path d="M3.5 9.5L7 13L14.5 5" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}

export function TokenSelectSheet({
  tokens,
  networks,
  selectedAddress,
  selectedChainId,
  activeNetworkId,
  chainId,
  isSui,
  onSelectToken,
  onSelectNetwork,
  onClose,
  title = 'Select a token',
  balanceMode = 'wallet',
  allowCustomSelection = false,
  hideZeroBalances = false,
}: {
  /** Assets the pool accepts on the ACTIVE chain (caller's config). */
  tokens: TokenSelectSheetToken[];
  networks: TokenSelectSheetNetwork[];
  /** Address / Move coin type of the current selection. */
  selectedAddress: string;
  /**
   * Chain the current selection lives on. Needed because an address alone is
   * ambiguous across chains (every EVM native asset shares one sentinel), so
   * without it the check mark landed on the acting chain's row instead of the
   * selected one.
   */
  selectedChainId?: number;
  /** Selected network, or null for "all chains" (every listed token shows). */
  activeNetworkId: number | null;
  /** EVM chain id used for on-chain reads + the swap-route gate. */
  chainId: number;
  isSui: boolean;
  onSelectToken: (token: TokenSelectSheetToken) => void;
  /** null clears the network filter (tapping the active chip again). */
  onSelectNetwork: (networkId: number | null) => void;
  onClose: () => void;
  title?: string;
  /**
   * Which balance the rows are ABOUT. 'wallet' (deposit/shield: what you can
   * pay with, wallet balance as the figure) or 'shielded' (withdraw/send/swap:
   * what you can SPEND from the pool — wallet balances are irrelevant there
   * and were confusing next to the private figure).
   */
  /**
   * Which figure the sheet is about. 'wallet' ranks by USD and offers pasted
   * custom tokens; 'shielded' ranks by what is already in the pool; 'none' is
   * for a list where the viewer's own holdings are irrelevant to the choice
   * (a payment request: the PAYER fulfils it, so the creator's balance says
   * nothing about whether the asset can be requested).
   */
  balanceMode?: 'wallet' | 'shielded' | 'none';
  /**
   * Whether a PASTED (non-catalog) row may be OFFERED and selected.
   *
   * Default false, and it has to be. This used to be keyed off wallet mode as
   * well, and since `balanceMode` defaults to 'wallet' that made pasted rows
   * clickable in every destination picker - the swap-output picker, the Shield
   * destination pool sheet, Transfer "Receive as" - not just the pay sheet it
   * was meant for. Those callbacks mostly fail closed, but "mostly" is not a
   * safety property: the pool picker in particular could turn a spoofed symbol
   * into the canonical same-symbol pool.
   *
   * The default is what protects those pickers, so this flag is now the ONLY
   * gate and every one of them is unchanged by that. Only a caller that can
   * genuinely adopt an arbitrary token opts in, which means one that will do
   * something sensible with a token it has never heard of. Withdraw's "Receive
   * as" qualifies: LiFi routes to any ERC-20 and hands it to the wallet, and
   * an address that routes nowhere fails as a missing route rather than as a
   * token mistaken for one of ours.
   */
  allowCustomSelection?: boolean;
  /**
   * Group the list by what the wallet holds. For the token you are SPENDING
   * (the Shield pay picker): the holdings come first, since they are the
   * deposits that can be funded today (Pat, 2026-09-04, on a list where five
   * of eight rows read 0.00), and the pool assets the wallet does NOT hold
   * follow under their own heading rather than vanishing (Mike, 2026-09-18:
   * the picker must still say what can be shielded here). A wallet-fed row
   * that is not a pool asset and holds nothing is dropped. Destination
   * pickers must NOT set this - what you receive has no reason to be
   * something you already hold.
   *
   * An `undefined` balance means one of two things, and they are treated
   * differently (Pat, 2026-09-05):
   *   - the wallet reads are still IN FLIGHT: the row is WITHHELD, because
   *     keeping it painted the whole catalog for a beat and then collapsed it
   *     to the funded rows - the flash this exists to remove;
   *   - the reads have LANDED and this one is unknown (a chain whose read
   *     failed): the row is KEPT and says "—", because "unknown" is honest
   *     while a fake 0 would hide real money.
   * The current selection always stays, so the sheet always shows what it is
   * selecting. Sui and a disconnected wallet never reach the withheld path
   * (no EVM read is in flight). 'wallet' mode only.
   */
  hideZeroBalances?: boolean;
}) {
  // Android back closes the picker instead of leaving the app.
  useBackHandler(true, onClose);
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { width } = useWindowDimensions();
  // Narrow viewports get an edge-to-edge full-screen sheet; desktop gets a
  // centered card. Same 560px break the two-pane selector uses.
  const narrow = width < 560;
  const [search, setSearch] = useState('');
  // Unknown / scam-shaped holdings stay out of the list until asked for.
  const [showSuspicious, setShowSuspicious] = useState(false);
  // The "•••" overflow menu of the network chip row.
  const [networkMenuOpen, setNetworkMenuOpen] = useState(false);

  // Intent swaps are the ONLY non-pool route into the pool, and they are
  // flag + processor gated (fail closed) and EVM-only. Off ⇒ a non-pool asset
  // is not selectable, exactly like every other swap entry point in the app.
  const swapRouteAvailable = !isSui && intentSwapsEnabledForChain(chainId);

  // Shielded balances, from the same provider every other surface reads — so
  // this sheet can never disagree with the balance shown on the form behind it.
  const { data: poolsData } = usePools();
  const balanceDisplay = useBalanceDisplay(chainId);
  const privateByToken = useMemo(() => {
    const map = new Map<string, ReturnType<typeof balanceDisplay>>();
    poolsData.myPools.forEach((pool) => {
      const amount = Number(pool.balanceTokenExact);
      // A zero (or unparseable) shielded balance contributes nothing: the row
      // omits the line rather than printing "0 private".
      if (!Number.isFinite(amount) || amount <= 0) return;
      const key = pool.tokenAddress?.toLowerCase();
      const formatted = balanceDisplay(pool.balanceTokenExact, pool.name, pool.chainId, pool.tokenAddress);
      // Chain-qualified keys: myPools spans chains, and a bare address/symbol
      // key let a foreign row overwrite the active chain's entry — guaranteed
      // for the shared native sentinel (kimi review, finding 3).
      if (key) map.set(`${pool.chainId}:${key}`, formatted);
      // Also keyed by symbol: Sui pools carry a Move coin type rather than an
      // 0x address, so an address-only lookup would miss them.
      map.set(`${pool.chainId}:${pool.name.toUpperCase()}`, formatted);
    });
    return map;
  }, [poolsData.myPools, balanceDisplay]);

  const { address: evmAddress } = useAccount();
  const suiAccount = useCurrentAccount();
  const suiOwner = suiAccount?.address;

  // --- REAL balances ---

  // Native balances per CHAIN, one read on each chain a native row lives on.
  // This used to be a single useBalance pinned to the sheet's chain (pinning
  // was right: unpinned, wagmi answers for whatever chain the WALLET sits on).
  // But an all-chains pay list has a BNB row and a cBTC row too, and the one
  // pinned read left every other chain's native row at "—" for good - which the
  // zero-balance filter then kept as "still loading" (Pat, 2026-09-05). A
  // chain whose read fails stays unknown, never a fake 0.
  const wagmiConfig = useConfig();
  // Sorted, so two callers listing the same chains in a different order share
  // one cache entry instead of paying a cold key each (codex, 2026-09-05).
  const nativeChainIds = useMemo(
    () => (isSui
      ? []
      : [...new Set(tokens.filter((t) => t.isNative && !t.unavailableReason).map((t) => t.chainId ?? chainId))].sort((a, b) => a - b)),
    [isSui, tokens, chainId],
  );
  const nativeQuery = useQuery({
    queryKey: ['tokenSheetNativeBalances', evmAddress, nativeChainIds],
    enabled: !isSui && !!evmAddress && balanceMode === 'wallet' && nativeChainIds.length > 0,
    // No staleTime, on purpose: with a fresh window a cached ZERO survived a
    // remount, so a wallet funded seconds ago kept its native row hidden for
    // the life of the sheet. Default freshness (0) refetches on mount, exactly
    // like the ERC-20 multicall next to it and the useBalance this replaced
    // (codex finding 1, 2026-09-05).
    queryFn: async () => {
      const read = await Promise.all(nativeChainIds.map(async (id) => {
        try {
          const b = await getBalance(wagmiConfig, {
            address: evmAddress as ViemAddress,
            chainId: id as (typeof wagmiConfig)['chains'][number]['id'],
          });
          return [id, Number(formatUnits(b.value, b.decimals))] as const;
        } catch {
          return [id, undefined] as const;
        }
      }));
      const out: Record<number, number> = {};
      for (const [id, value] of read) if (value !== undefined) out[id] = value;
      return out;
    },
  });
  const nativeBalanceByChain = nativeQuery.data;

  // Suspicious rows are left out: they get their own read below.
  const erc20Tokens = useMemo(
    () => (isSui ? [] : tokens.filter((t) => !t.isNative && !t.suspicious && !t.unavailableReason)),
    [isSui, tokens],
  );

  // A row's chain: its own when the caller lists several chains at once,
  // otherwise the sheet's.
  const chainNameOf = useCallback(
    (id: number) => networks.find((n) => n.id === id)?.name ?? getChainConfig(id)?.displayName ?? holdingsChainName(id) ?? `Chain ${id}`,
    [networks],
  );

  const chainOf = useCallback(
    (token: TokenSelectSheetToken) => token.chainId ?? chainId,
    [chainId],
  );

  const erc20Contracts = useMemo(
    () =>
      evmAddress
        ? erc20Tokens.map((t) => ({
            address: t.address as ViemAddress,
            abi: erc20Abi,
            functionName: 'balanceOf' as const,
            args: [evmAddress],
            // Pinned per TOKEN: an all-chains list reads each balance on the
            // chain that token actually lives on.
            chainId: t.chainId ?? chainId,
          }))
        : [],
    [erc20Tokens, evmAddress, chainId],
  );

  const erc20Query = useReadContracts({
    contracts: erc20Contracts,
    // Wallet balances are only the subject in 'wallet' mode; a spend sheet
    // never shows them, so it must not fan out multicalls for them either.
    query: { enabled: !isSui && balanceMode === 'wallet' && erc20Contracts.length > 0 },
  });
  const erc20Balances = erc20Query.data;

  // Wallet reads in flight. isLoading is pending AND fetching, so a query that
  // is merely disabled (no wallet, a spend sheet) never counts as loading.
  // While this is true an UNKNOWN balance is withheld rather than listed: the
  // pay picker used to paint every row for a beat and then collapse to the
  // ones with a balance (Pat, 2026-09-05).
  const walletBalancesLoading = !isSui && balanceMode === 'wallet'
    && (nativeQuery.isLoading || erc20Query.isLoading);

  const erc20BalanceByAddress = useMemo(() => {
    const map = new Map<string, number>();
    erc20Tokens.forEach((token, i) => {
      const entry = erc20Balances?.[i];
      if (entry?.status === 'success' && typeof entry.result === 'bigint') {
        map.set(`${token.chainId ?? chainId}:${token.address.toLowerCase()}`, Number(formatUnits(entry.result, token.decimals)));
      }
    });
    return map;
  }, [erc20Tokens, erc20Balances, chainId]);

  // Suspicious rows are NEVER read on-chain from here: gating a multicall on
  // `showSuspicious` let the RPC provider correlate the reveal tap with the
  // wallet-address balance reads happening beside it (codex P1). They show
  // only the caller's already-fetched `walletBalance` (Alchemy's, prewarmed
  // for every wallet row regardless of what is expanded).

  // Sui: the *native* SUI balance only — identical to the deposit modal and
  // the action hub. SUI is currently the sole configured Sui asset; a future
  // non-SUI coin type would need its own getBalance({ coinType }) read, so its
  // row honestly renders "—" instead of a wrong or invented number.
  const { data: suiBalanceData } = useSuiClientQuery(
    'getBalance',
    { owner: suiOwner ?? '' },
    { enabled: isSui && !!suiOwner },
  );

  // --- REAL prices (ASP /global/public/token-prices, Alchemy fallback) ---

  // Every chain's prices, off the public-feed grid. This sheet lists tokens
  // across networks, so it wants them all — but it must not ASK for them: the
  // unscoped getAllPrices() it used to call keyed a cache scope the scheduler
  // never warms, so opening the sheet was itself a request.
  const priceMap = useAllChainsPriceMap(chainId);

  // Keyed on the ROW's chain, like its balance and its key already are. This
  // list spans networks and every EVM chain shares one native sentinel
  // address, so a bare address lookup handed a Citrea cBTC row the active
  // chain's ether price. A zero is the ASP's testnet reading for "unknown",
  // not a price; priceFromMap drops those.
  const priceFor = (token: TokenSelectSheetToken): number | undefined =>
    priceFromMap(priceMap, { chainId: chainOf(token), address: token.address, symbol: token.symbol });

  // --- Paste-any-address: REAL on-chain metadata ---

  const query = search.trim();
  const isAddressQuery = ADDRESS_RE.test(query);
  const alreadyListed =
    isAddressQuery && tokens.some((t) => t.address.toLowerCase() === query.toLowerCase());
  // EVM-only: a Move coin type is not an 0x-address, so there is nothing to
  // resolve with erc20Abi on Sui.
  //
  // Gated on the caller's opt-in rather than on `balanceMode`. Those were the
  // same thing while the pay sheet was the only picker that could adopt an
  // arbitrary token, but Withdraw's "Receive as" can too: LiFi routes to any
  // ERC-20 and hands it to the user's wallet, and that picker ranks by the
  // SHIELDED holding it is spending. Keying the paste row off the ranking mode
  // made those two questions one, so a caller could not answer them
  // differently (Mike, 2026-09-22: "I should be able to select any random
  // Ethereum ERC-20 on withdrawal, no?").
  //
  // `allowCustomSelection` still defaults false, so every picker that has not
  // opted in is unchanged, including the ones the note below names.
  const customEnabled = !isSui && allowCustomSelection && isAddressQuery && !alreadyListed;
  const customAddress = customEnabled ? (query as ViemAddress) : undefined;

  const {
    data: customMeta,
    isLoading: customLoading,
    isError: customReadError,
  } = useReadContracts({
    contracts: [
      { address: customAddress, abi: erc20Abi, functionName: 'symbol', chainId },
      { address: customAddress, abi: erc20Abi, functionName: 'name', chainId },
      { address: customAddress, abi: erc20Abi, functionName: 'decimals', chainId },
    ],
    query: { enabled: customEnabled },
  });

  const { data: customBalanceRaw } = useReadContract({
    address: customAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: evmAddress ? [evmAddress] : undefined,
    chainId,
    query: { enabled: customEnabled && !!evmAddress },
  });

  // A non-token address (or a proxy that reverts) fails the reads instead of
  // throwing — `allowFailure` is wagmi's default, so each entry carries its
  // own status and the sheet degrades to an inline message.
  const customToken = useMemo<TokenSelectSheetToken | undefined>(() => {
    if (!customEnabled || !customMeta) return undefined;
    const [symbolRes, nameRes, decimalsRes] = customMeta;
    if (symbolRes?.status !== 'success' || decimalsRes?.status !== 'success') return undefined;
    const decimals = Number(decimalsRes.result);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return undefined;
    const symbol = String(symbolRes.result ?? '').trim();
    return {
      symbol: symbol || `${query.slice(0, 6)}…${query.slice(-4)}`,
      name: nameRes?.status === 'success' ? String(nameRes.result ?? '').trim() || undefined : undefined,
      address: query,
      decimals,
      isNative: false,
    };
  }, [customEnabled, customMeta, query]);

  const customFailed = customEnabled && !customLoading && (customReadError || (!!customMeta && !customToken));

  // --- Rows: filter, then sort by REAL USD value (no price ⇒ alphabetical) ---

  const rows = useMemo<TokenRow[]>(() => {
    const balanceOf = (token: TokenSelectSheetToken): number | undefined => {
      if (isSui) {
        if (!token.isNative || !suiBalanceData) return undefined;
        return Number(formatUnits(BigInt(suiBalanceData.totalBalance), token.decimals));
      }
      // Holdings-only chain: the wallet poll's figure, no read of our own.
      if (token.unavailableReason) return token.walletBalance;
      if (token.isNative) {
        // Read on the ROW's chain (see nativeQuery): undefined until it lands,
        // or for a chain whose read failed.
        return nativeBalanceByChain?.[chainOf(token)];
      }
      if (token.suspicious) {
        return token.walletBalance;
      }
      return erc20BalanceByAddress.get(`${chainOf(token)}:${token.address.toLowerCase()}`);
    };

    const toRow = (token: TokenSelectSheetToken, custom: boolean): TokenRow => {
      const balance = balanceMode !== 'wallet'
        ? undefined // a spend sheet is about the SHIELDED figure, nothing else; 'none' shows no figure at all
        : custom
          ? (customBalanceRaw != null ? Number(formatUnits(customBalanceRaw as bigint, token.decimals)) : undefined)
          : balanceOf(token);
      const price = priceFor(token);
      // Read with the ROW's chain (an all-chains list spans several).
      const rowChain = chainOf(token);
      const priv = privateByToken.get(`${rowChain}:${token.address.toLowerCase()}`)
        ?? privateByToken.get(`${rowChain}:${token.symbol.toUpperCase()}`);
      return {
        key: `${custom ? 'custom' : 'pool'}:${rowChain}:${token.address.toLowerCase()}`,
        symbol: token.symbol,
        name: token.name,
        logoUrl: token.logoUrl,
        address: token.address,
        decimals: token.decimals,
        isNative: !!token.isNative,
        chainId: rowChain,
        suspicious: !!token.suspicious,
        comingSoon: !!token.comingSoon,
        ...(token.unavailableReason ? { unavailableReason: token.unavailableReason } : {}),
        balance,
        usdValue: price != null && balance != null
          ? balance * price
          : (token.unavailableReason ? token.walletUsdValue : undefined),
        // Custom (pasted) tokens are not pool assets, so they have no shielded
        // balance by definition.
        ...(!custom && priv && balanceMode !== 'none' ? { privateBalance: priv.text, privateHint: priv.hint } : {}),
        poolSupported: !custom,
        custom,
        poolAsset: !custom && !!token.poolAsset,
      };
    };

    const needle = query.toLowerCase();
    const configured = tokens
      .filter((t) => activeNetworkId === null || (t.chainId ?? chainId) === activeNetworkId)
      .filter(
        (t) =>
          !needle
          || t.symbol.toLowerCase().includes(needle)
          || (t.name ?? '').toLowerCase().includes(needle)
          || t.address.toLowerCase().includes(needle),
      )
      .map((t) => toRow(t, false));

    // Ranked by the figure the sheet is ABOUT: shielded balance on a spend
    // sheet, wallet USD on a pay sheet. Rows without that figure keep a stable
    // alphabetical order (a missing value is never guessed).
    // 'none' ranks nothing: with no figure on the rows there is nothing to
    // rank BY, so every row falls through to the stable alphabetical order.
    const rankOf = (r: TokenRow) => (balanceMode === 'none'
      ? null
      : balanceMode === 'shielded'
        ? (r.privateBalance != null ? parseFloat(String(r.privateBalance).replace(/[^0-9.]/g, '')) || 0 : null)
        : (r.usdValue ?? null));
    const priced = configured.filter((r) => rankOf(r) != null);
    const unpriced = configured.filter((r) => rankOf(r) == null);
    priced.sort((a, b) => (rankOf(b)! - rankOf(a)!) || a.symbol.localeCompare(b.symbol));
    unpriced.sort((a, b) => a.symbol.localeCompare(b.symbol));

    // Suspicious rows always sort last, so revealing them appends rather than
    // reshuffling the list the user was already reading.
    const bySuspicion = (a: TokenRow, b: TokenRow) => Number(a.suspicious) - Number(b.suspicious);
    const sorted = [...priced, ...unpriced].sort(bySuspicion);
    // A pay picker lists what can actually fund the deposit. An unknown
    // balance is withheld while the wallet reads are in flight (else the whole
    // catalog flashes up and then collapses) and kept once they have landed,
    // since "unknown" is then honest and the row says "—". The current
    // selection always stays.
    // A pay picker is grouped (Mike, 2026-09-18): first what the wallet HOLDS
    // (the deposit it can fund today), then every pool asset it does not hold,
    // so the sheet always answers "what can I shield here" - from an empty or
    // disconnected wallet it is simply the pool list. A wallet-fed row that is
    // not a pool asset and holds nothing is dropped as before: an unknown
    // balance is withheld while the wallet reads are in flight (else the row
    // flashes up and collapses) and kept once they have landed, since
    // "unknown" is then honest and the row says "—". The current selection
    // always stays.
    const isSelectedRow = (r: TokenRow) => r.address.toLowerCase() === selectedAddress.toLowerCase()
      && (selectedChainId === undefined || r.chainId === selectedChainId);
    const grouped = hideZeroBalances && balanceMode === 'wallet'
      ? sorted.flatMap((r): TokenRow[] => {
        if (r.balance != null && r.balance > 0) return [{ ...r, section: 'wallet' }];
        if (r.poolAsset || r.comingSoon) return [{ ...r, section: 'pools' }];
        if ((r.balance == null && !walletBalancesLoading) || isSelectedRow(r)) return [{ ...r, section: 'wallet' }];
        return [];
      })
      : sorted;
    return customToken ? [{ ...toRow(customToken, true), section: hideZeroBalances && balanceMode === 'wallet' ? 'wallet' : undefined }, ...grouped] : grouped;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    tokens,
    query,
    isSui,
    suiBalanceData,
    nativeBalanceByChain,
    erc20BalanceByAddress,
    walletBalancesLoading,
    customToken,
    customBalanceRaw,
    priceMap,
    privateByToken,
    hideZeroBalances,
    balanceMode,
    selectedAddress,
    selectedChainId,
  ]);

  // Rows the list actually renders, plus how many are being withheld: the
  // suspicious ones only appear once the user asks for them.
  const suspiciousCount = useMemo(() => rows.filter((r) => r.suspicious).length, [rows]);
  const visibleRows = useMemo(
    () => {
      if (showSuspicious) return rows;
      return rows.filter((r) => (
        !r.suspicious
        // Typing an EXACT address is itself the reveal (Pat, 2026-08-31): the
        // spam filter exists to hide AIRDROPPED lookalikes nobody asked for, and
        // a user who pasted this precise contract has asked for it. Without
        // this, pasting the address of a token Alchemy already flagged showed
        // nothing at all: `alreadyListed` suppresses the custom row, and the
        // configured row stays hidden behind the reveal (codex P2 #6). Scoped to
        // the exact match, so unrelated suspicious rows stay hidden.
        || (isAddressQuery && r.address.toLowerCase() === query.toLowerCase())
      ));
    },
    [rows, showSuspicious, isAddressQuery, query],
  );

  // Theme tokens only — they resolve per design variant AND per color scheme, so
  // there is no isDark branch here. A hardcoded light-mode grey (#F5F5F5 on
  // #B8BBBF) rendered a neutral box on all five LIGHT variants, clashing with
  // Warm Vault's beige and the Electric/Mono surfaces. Matches how every other
  // ported input is styled (zero isDark color branches app-wide).
  const searchClass =
    'rounded-pill border border-border bg-background-secondary px-[14px] py-[9px] font-pp-regular text-[13px] text-text';

  // One row, shared by the grouped and the flat list.
  const renderRow = (row: TokenRow) => {
    const isSelected = row.address.toLowerCase() === selectedAddress.toLowerCase()
      && row.chainId === (selectedChainId ?? chainId);
    // Only pool assets are selectable, with one deliberate exception:
    // a token the user PASTED.
    //
    // The original rule conflated two different things. A DESTINATION
    // pool asset must be one the pool accepts. A PAY token is any token
    // the user holds, swapped into a pool asset on the way in - that is
    // the whole point of swap-into-deposit, so refusing non-pool rows
    // there refused the feature (QA B-c: a pasted LINK could not be
    // used to pay).
    //
    // Custom rows only ever appear in 'wallet' mode (see customEnabled),
    // i.e. the pay-token sheet, so this exemption cannot leak into a
    // destination picker. Pasting a contract address is an explicit,
    // voluntary act, so it also bypasses the scam heuristic that hides
    // AIRDROPPED lookalikes nobody asked for (Pat, 2026-08-31).
    // A pool that has not opened yet overrides both: it IS a pool
    // asset, it just cannot take a deposit today.
    const selectable = !row.comingSoon && !row.unavailableReason
      && (row.poolSupported || (row.custom && allowCustomSelection));
    // No chain filter ⇒ the list spans chains, and the same symbol
    // appears once per chain. Name it.
    const chainSuffix = activeNetworkId === null ? ` · ${chainNameOf(row.chainId)}` : '';
    // The share this row earns through: itself when it IS a share, else
    // the share its deposit wraps into. By pay token, not by ERC-20
    // underlying: the native coin (ETH into ppETH) has none, and the
    // line went missing next to ETH while it showed for USDC/USDT
    // (Pat, 2026-09-18). A SPEND sheet keeps the legacy line, where
    // it is the truth.
    const shareAddress = isShareSymbol(row.symbol)
      ? row.address
      : balanceMode !== 'shielded'
        ? getConfiguredDepositRouteForPayToken(row.chainId, { address: row.address, isNative: row.isNative })?.ppUSDC
        : undefined;
    // The yield wording, when this row has one. A pay row the router
    // wraps on the way in is NOT closed: only its plain Entrypoint
    // deposit is (codex on f442e3b). Every deposit-side sheet, not
    // just the wallet one, and the CONFIGURED route rather than the
    // vault-verified one: the destination picker called USDC
    // "Deposits closed" on the very screen where picking it deposits
    // into ppUSDC (Pat, 2026-09-12). A pool that has not opened
    // outranks it (comingSoonSubtitle).
    const yieldLine = comingSoonSubtitle(row) || row.unavailableReason
      ? null
      : shareSubtitle(row.symbol)
        ?? (balanceMode !== 'shielded'
          ? wrapsIntoShareSubtitle(getKnownTokenMetadata(shareAddress ?? '', row.chainId)?.symbol)
          : null);
    const configured = tokens.find(
      (t) => t.address.toLowerCase() === row.address.toLowerCase()
        && (t.chainId ?? chainId) === row.chainId,
    );
    return (
      <Pressable
        key={row.key}
        disabled={!selectable}
        onPress={() => {
          // A pasted token is in no caller list, so `configured` misses
          // it; hand back the resolved custom token instead of dropping
          // the press silently.
          if (configured) onSelectToken(configured);
          else if (row.custom && allowCustomSelection && customToken) onSelectToken(customToken);
        }}
        className={`flex-row items-center gap-[12px] rounded-inner px-[8px] py-[10px] ${isSelected ? 'bg-background-secondary' : 'active:bg-background-secondary'} ${selectable ? 'opacity-100' : 'opacity-50'}`}
        testID={`token-select-row-${row.symbol}`}
        accessibilityRole="button"
        accessibilityLabel={`${balanceMode === 'shielded' ? poolDisplayLabel(row.symbol, row.chainId) : displayTokenSymbol(row.symbol)} on ${chainNameOf(row.chainId)}`}
      >
        <TokenNetworkIcon symbol={row.symbol} size={28} badgeSize={15} chainId={row.chainId} logoUri={row.logoUrl} />
        <View className="min-w-0 flex-1 gap-[2px]">
          <View className="flex-row flex-wrap items-center gap-[6px]">
            <Text className="font-pp-bold text-[15px] text-text" numberOfLines={1}>
              {balanceMode === 'shielded' ? poolDisplayLabel(row.symbol, row.chainId) : displayTokenSymbol(row.symbol)}
            </Text>
          </View>
          {row.suspicious ? (
            <Text className="font-pp-medium text-[11px] text-warning" numberOfLines={1}>
              Unverified · check the address
            </Text>
          ) : null}
          {/* The headline is the money (USDC); this line is what
              happens to it: a yield share says so and names itself, a
              closed legacy asset says deposits are over
              (services/share-display.ts). */}
          {yieldLine ? (
            <ShareYieldSubtitle chainId={row.chainId} shareAddress={shareAddress} fallback={yieldLine} suffix={chainSuffix} />
          ) : (
          <Text className="font-pp-regular text-[12px] text-text-muted" numberOfLines={1}>
            {(comingSoonSubtitle(row)
              ?? row.unavailableReason
              ?? (getKnownTokenMetadata(row.address, row.chainId)?.withdrawOnly ? LEGACY_ASSET_SUBTITLE : undefined)
              ?? row.name
              ?? (row.isNative ? 'Native asset' : `${row.address.slice(0, 6)}…${row.address.slice(-4)}`))
              + chainSuffix}
          </Text>
          )}
          {balanceMode === 'wallet' && !row.comingSoon && !row.unavailableReason && !row.poolSupported && !swapRouteAvailable ? (
            <Text className="font-pp-regular text-[11px] text-text-muted">
              Not accepted by this pool
            </Text>
          ) : null}
        </View>
        <View className="items-end gap-[2px]">
          {/* "—" when the balance is not readable — never a fake 0. In
              'none' there is no balance column at all: a dash on every
              row would read as "you cannot have this one". */}
          {balanceMode !== 'none' ? (
            <Text className="font-pp-medium text-[13px] text-text">
              {row.balance != null ? formatTokenBalance(row.balance, row.symbol) : '—'}
            </Text>
          ) : null}
          {/* The already-shielded balance, which is the figure that
              actually informs the choice here. The USD value of the
              wallet balance restated the line above it in another unit.
              Omitted entirely when the asset has nothing shielded, so a
              "0 private" line never competes with a real one. */}
          {row.privateHint ? <ShareCountHint hint={row.privateHint} /> : null}
          {row.privateBalance ? (
            <Text className="font-pp-regular text-[11px] text-text-muted">
              {row.privateBalance} private
            </Text>
          ) : null}
        </View>
        {isSelected ? (
          // nw-keep(data-color): check stroke is the tint theme token into the SVG icon prop
          <CheckIcon color={colors.tint} />
        ) : null}
      </Pressable>
    );
  };

  // The pay sheet's two groups (see hideZeroBalances). Headings only when
  // both have rows: an empty or disconnected wallet just sees the pools.
  const walletRows = visibleRows.filter((r) => r.section !== 'pools');
  const poolRows = visibleRows.filter((r) => r.section === 'pools');
  const groupHeadings = walletRows.length > 0 && poolRows.length > 0;
  const poolsHeading = activeNetworkId === null ? 'Pools' : `Pools on ${chainNameOf(activeNetworkId)}`;
  const listItems: ListItem[] = [
    ...(groupHeadings ? [{ kind: 'heading' as const, key: 'heading:wallet', section: 'wallet' as const }] : []),
    ...walletRows.map((row) => ({ kind: 'row' as const, key: row.key, row })),
    ...(groupHeadings ? [{ kind: 'heading' as const, key: 'heading:pools', section: 'pools' as const }] : []),
    ...poolRows.map((row) => ({ kind: 'row' as const, key: row.key, row })),
  ];
  const renderListItem = ({ item }: { item: ListItem }) => {
    if (item.kind === 'row') return renderRow(item.row);
    return item.section === 'wallet'
      ? <Text className="px-[8px] pb-[4px] pt-[6px] font-pp-medium text-[11.5px] text-text-muted" testID="token-select-heading-wallet">In your wallet</Text>
      : <Text className="px-[8px] pb-[4px] pt-[14px] font-pp-medium text-[11.5px] text-text-muted" testID="token-select-heading-pools">{poolsHeading}</Text>;
  };

  return (
    <View
      // Narrow vs wide are MUTUALLY EXCLUSIVE branches: two co-active classes
      // on the same CSS property resolve by emission order on web, not class
      // order, so neither justify-* nor p-* has an unconditional base here.
      className={`inset-0 z-[1000000] items-center ${narrow ? 'justify-start p-0' : 'justify-center p-[20px]'}`}
      // nw-keep(platform-css): position fixed on web / absolute full-screen on native (RN has no 'fixed')
      style={OVERLAY_POSITION}
    >
      {/* Scheme-neutral single scrim: this sheet layers OVER the deposit modal,
          which already laid its own rgba(0,0,0,0.5) scrim down, so a second
          heavy scrim would double-darken. Deliberately not the --pp-overlay
          token: every sibling modal uses a hardcoded black scrim (the port kept
          those literals rather than retokenizing them), and a per-variant
          overlay here would tint differently from the layer beneath it. */}
      <Pressable className="absolute inset-0 bg-[rgba(0,0,0,0.35)]" onPress={onClose} />

      {/* Full-screen on phones, centered card on desktop — again a single
          exclusive ternary per CSS property (size, radius, border). */}
      <View
        className={`overflow-hidden border-border bg-card-background ${
          narrow
            ? 'h-full w-full max-w-full rounded-none border-0'
            : 'h-[620px] max-h-[86%] w-full max-w-[520px] rounded-card border'
        }`}
        testID="token-select-sheet"
      >
        {/* Header */}
        <View className="flex-row items-center justify-between gap-[12px] px-[16px] pb-[12px] pt-[16px]">
          <Text className="font-pp-bold text-[16px] text-text">{title}</Text>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close token selector">
            {/* nw-keep(data-color): close glyph stroke is the text theme token into the SVG icon prop */}
            <CloseIcon color={colors.text} />
          </Pressable>
        </View>

        {/* Network — the app-wide chain selection, unchanged semantics (same
            `onSelectNetwork` contract the two-pane selector had). Rendered
            even with a single supported network so the sheet always states
            which chain the balances and routes below belong to. */}
        {networks.length > 0 && (() => {
          const renderChip = (net: TokenSelectSheetNetwork, inMenu = false) => {
            const active = net.id === activeNetworkId;
            if (net.unavailableReason) {
              return (
                <View
                  key={net.id}
                  accessible
                  className={`flex-row items-center gap-[6px] ${inMenu ? 'px-[12px] py-[8px]' : 'rounded-pill border border-border px-[10px] py-[5px]'} opacity-50`}
                  accessibilityLabel={`${net.name}: ${net.unavailableReason}`}
                  accessibilityState={{ disabled: true }}
                  testID={`token-sheet-network-unavailable-${net.id}`}
                >
                  <ChainLogo chain={chainLogoChainFor(net.id)} size={16} />
                  <Text className="font-pp-medium text-[12px] text-text-secondary">{net.name}</Text>
                  <Text className="font-pp-medium text-[11px] text-text-muted">{net.unavailableReason}</Text>
                </View>
              );
            }
            return (
              <Pressable
                key={net.id}
                className={`flex-row items-center gap-[6px] ${inMenu ? 'px-[12px] py-[8px] active:bg-background-secondary' : `rounded-pill border px-[10px] py-[5px] ${active ? 'border-tint bg-background-secondary' : 'border-border active:bg-background-secondary'}`}`}
                // Tapping the ACTIVE chip clears the filter (back to every
                // chain) rather than re-selecting what is already selected —
                // unless it is the ONLY chain, where the chip is just a label
                // for the balances below and there is nothing to clear to.
                onPress={() => {
                  setNetworkMenuOpen(false);
                  onSelectNetwork(active && networks.length > 1 ? null : net.id);
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                testID={inMenu ? `token-sheet-network-more-${net.id}` : undefined}
              >
                <ChainLogo chain={chainLogoChainFor(net.id)} size={16} />
                <Text className={`font-pp-medium text-[12px] ${active ? 'text-text' : 'text-text-secondary'}`}>
                  {net.name}
                </Text>
              </Pressable>
            );
          };
          const { visible, overflow } = splitNetworkChips(networks);
          // The picked chain is behind the bubble: the bubble reads as active.
          const overflowActive = overflow.some((n) => n.id === activeNetworkId);
          return (
            <View className="pb-[12px]">
              <View
                className="flex-row flex-wrap items-center gap-[8px] px-[16px]"
              >
                {visible.map((net) => renderChip(net))}
                {/* The chains that don't fit sit behind a bubble (Mike, #276). */}
                {overflow.length > 0 && (
                  <Pressable
                    className={`items-center justify-center rounded-pill border px-[10px] py-[5px] ${networkMenuOpen || overflowActive ? 'border-tint bg-background-secondary' : 'border-border active:bg-background-secondary'}`}
                    onPress={() => setNetworkMenuOpen((o) => !o)}
                    accessibilityRole="button"
                    accessibilityLabel="More networks"
                    accessibilityState={{ expanded: networkMenuOpen, selected: overflowActive }}
                    testID="token-sheet-network-more"
                  >
                    <Text className="font-pp-medium text-[12px] text-text-secondary">•••</Text>
                  </Pressable>
                )}
                {/* Discreet clear — only while a chain is filtering a list that
                    spans several. With one network the chip states the chain and
                    there is nothing to widen to. */}
                {activeNetworkId !== null && networks.length > 1 && (
                  <Pressable
                    className="flex-row items-center gap-[4px] rounded-pill px-[8px] py-[5px] active:bg-background-secondary"
                    onPress={() => onSelectNetwork(null)}
                    accessibilityRole="button"
                    accessibilityLabel="Show every chain"
                    testID="token-sheet-clear-chain"
                  >
                    {/* nw-keep(data-color): glyph color is a runtime theme token (vector-icon sink) */}
                    <Ionicons name="close" size={11} color={colors.textMuted} />
                    <Text className="font-pp-medium text-[11.5px] text-text-muted">All chains</Text>
                  </Pressable>
                )}
              </View>
              {networkMenuOpen && overflow.length > 0 && (
                <View
                  className="mx-[16px] mt-[8px] overflow-hidden rounded-[12px] border border-border bg-background"
                  accessibilityLabel="More networks"
                  testID="token-sheet-network-more-menu"
                >
                  {overflow.map((net) => renderChip(net, true))}
                </View>
              )}
            </View>
          );
        })()}

        {/* Search — symbol, name, or a pasted contract address. */}
        <View className="px-[16px] pb-[12px]">
          <TextInput
            className={searchClass}
            placeholder="Search name or paste address"
            // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
            placeholderTextColor={colors.textMuted}
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        {/* Pasted-address states. Resolution is a real on-chain read, so it
            can be pending or fail. Never a crash, never a guessed token. */}
        {customEnabled && customLoading && (
          <Text className="px-[16px] pb-[10px] font-pp-regular text-[12px] text-text-muted">
            Reading token from chain…
          </Text>
        )}
        {customFailed ? (
          <Text
            className="px-[16px] pb-[10px] font-pp-regular text-[12px] text-warning"
            testID="token-select-custom-error"
          >
            Couldn&apos;t read this token. No ERC-20 symbol/decimals at that address on this network.
          </Text>
        ) : null}

        {/* Virtualized: a wallet can hold hundreds of tokens, and each row
            carries a logo and a balance. Only the rows near the viewport mount. */}
        <FlatList
          className="flex-1"
          contentContainerClassName="px-[8px] pb-[16px]"
          keyboardShouldPersistTaps="handled"
          data={listItems}
          keyExtractor={(item) => item.key}
          renderItem={renderListItem}
          initialNumToRender={14}
          maxToRenderPerBatch={14}
          windowSize={7}
          ListHeaderComponent={
            <>
              {visibleRows.length === 0 && !customEnabled ? (
                <Text className="px-[8px] py-[16px] font-pp-regular text-[13px] text-text-muted">
                  {/* Loading is checked BEFORE the search: while balances are still
                      in flight a matching row is merely withheld, and "No token
                      matches USDC" would be a lie about a token that is only
                      waiting on its balance (codex finding 2, 2026-09-05). */}
                  {walletBalancesLoading && hideZeroBalances
                    ? 'Reading wallet balances…'
                    : query
                      ? `No token matches “${query}”.`
                      : balanceMode === 'shielded'
                        ? 'No pools with a shielded balance yet.'
                        : 'No tokens to show.'}
                </Text>
              ) : null}
            </>
          }
          ListFooterComponent={
            <>
              {/* Withheld holdings, offered rather than hidden: unpriced airdrops,
                  impersonators of a configured asset, homoglyph/link metadata (see
                  services/token-spam-filter). Mainnets only — nothing on a test
                  network is ever marked. */}
              {suspiciousCount > 0 ? (
                <Pressable
                  className="mt-[6px] flex-row items-center justify-center gap-[6px] rounded-inner py-[10px] active:bg-background-secondary"
                  onPress={() => setShowSuspicious((v) => !v)}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: showSuspicious }}
                  testID="token-sheet-toggle-suspicious"
                >
                  {/* nw-keep(data-color): glyph color is a runtime theme token (vector-icon sink) */}
                  <Ionicons name={showSuspicious ? 'eye-off-outline' : 'eye-outline'} size={13} color={colors.textMuted} />
                  <Text className="font-pp-regular text-[12px] text-text-muted">
                    {showSuspicious
                      ? `Hide ${suspiciousCount} unknown or suspicious`
                      : `Show ${suspiciousCount} unknown or suspicious token${suspiciousCount === 1 ? '' : 's'}`}
                  </Text>
                </Pressable>
              ) : null}
            </>
          }
        />

      </View>
    </View>
  );
}
