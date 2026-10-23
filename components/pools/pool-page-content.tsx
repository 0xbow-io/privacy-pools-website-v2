import { useTabBarClearance } from '@/hooks/use-tab-bar-clearance';
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
import { poolVisible } from '@/services/pool-visibility-rule';
import { isSupersededLegacyPool, poolDisplayLabel, poolSymbolFromRoute } from '@/config/pool-paths';
import { Fragment, useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { ScrollView, View, Text, Pressable, Platform, useWindowDimensions } from 'react-native';
import { myActivityCells, poolCardsRowClassName } from '@/services/pool-my-activity';
import { useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { useAccount, useSwitchChain, useChainId } from 'wagmi';
import { usePoolSession } from '@/hooks/use-pool-session';
import { useQuery } from '@tanstack/react-query';
import { Header } from '@/components/ui/header';
import { Footer } from '@/components/ui/footer';
import { Card } from '@/components/ui/card';
import { ActionHub } from '@/components/home/action-hub';
import {
  EMPTY_SELECTION,
  ExplorePanelProvider,
  SPLIT_GAP,
  SPLIT_LEFT_WIDTH,
  SPLIT_MAX_WIDTH,
  SPLIT_MIN_WIDTH,
  type PanelSelection,
  type SelectAssetInput,
} from '@/components/home/explore-panel-context';
import { PortfolioNetValue, type TimePeriod } from '@/components/portfolio/portfolio-net-value';
import { usePortfolioHistory } from '@/hooks/use-portfolio-history';
import { getTokenMetadata, NATIVE_ASSET_ADDRESS, getTokenMetadataBySymbol } from '@/config/tokens';
import { getSwapInputTokens } from '@/config/intent-swaps';
import { resolveHandoffToken } from '@/services/swap-token-handoff';
import { sameSymbol } from '@/services/symbol-match';
import { CHAIN_OPTIONS } from '@/components/pools/chain-selector';
import { usePools, formatUsd } from '@/components/pools-provider';
import { formatUnits } from 'viem';
import { approxUnderlyingText, comingSoonDepositMessage, displayTokenSymbol } from '@/services/share-display';
import { useShareRates } from '@/hooks/use-share-rates';
import { formatShareAsUnderlying, shareNumberAsUnderlying, underlyingPriceFor } from '@/services/share-rates';
import { shareBalanceDisplay } from '@/services/share-balance-display';
import { ShareCountHint } from '@/components/pools/share-count-hint';
import { useDepositModal } from '@/components/deposit-modal-provider';
import { useWithdrawModal } from '@/components/withdraw-modal-provider';
import { useTransferModal } from '@/components/transfer-modal-provider';
import { useSwapModal } from '@/components/swap-modal-provider';
import { usePaymentRequestModal } from '@/components/payment-request-modal-provider';
import { useSupportedWalletConnection } from '@/hooks/use-supported-wallet-connection';
import { useMultiChainWallet } from '@/hooks/use-multi-chain-wallet';
import { useNotes } from '@/hooks/use-notes';
import { fundedActionsDisabled } from '@/services/action-gate';
import { isMyDeposit, normalizeCommitment } from '@/services/deposit-ownership';
import { buildPaidRequestTxHashSet } from '@/services/paid-requests-store';
import { buildOutgoingDepositTxHashSet } from '@/services/outgoing-deposits-store';
import { isInternalSpendRow, mergeMyTransactions } from '@/services/transfer-direction';
import { anyLeg, isSwapRow } from '@/services/swap-rows';
import { useAllChainsPriceMap } from '@/hooks/use-all-chains-price-map';
import { defaultChainId, supportedChainIds, supportedEvmChainIds, getChainConfig, getSupportedChains, STELLAR_TESTNET_ID, SUI_TESTNET_ID } from '@/config/chains';
import { useChainRouter } from '@/hooks/use-chain-router';
import { getConfiguredYieldDeployments, YIELD_APY_PERCENT } from '@/config/yield';
import { useShareYield } from '@/hooks/use-share-yield';
import {
  tokenIconFor,
  SCORE_COLORS,
  type PoolOption,
  type PoolAccount,
} from './pool-page-shared';
import { PoolPageHeader } from './pool-page-header';
import { mustLeavePoolPageToSwitch } from '@/services/pool-page-chain-switch';
import { PoolPageStatsCard } from './pool-page-stats-card';
import { useAssetStatistics } from '@/hooks/use-asset-statistics';
import { PoolPageAccountsGrid } from './pool-page-accounts-grid';
import { MyPrivacyPools } from './my-privacy-pools';
import { PoolActionPanel, type PoolPanelAction } from './pool-action-panel';
import { Transactions } from './transactions';

// The transfer modal's prefill only accepts these three symbols (EVM); a pool
// page for anything else simply doesn't pre-select a token.

/**
 * Slug → chain id, derived from the build's chain set rather than a two-entry
 * literal. The literal knew only eth/sepolia, so on staging the Citrea option
 * resolved to undefined and was filtered straight back out of the selector.
 */
const CHAIN_SELECTOR_TO_ID: Record<string, number> = Object.fromEntries(
  supportedEvmChainIds
    .map((id) => [getChainConfig(id)?.name?.toLowerCase(), id] as const)
    .filter((entry): entry is readonly [string, number] => typeof entry[0] === 'string'),
);

const WAGMI_SUPPORTED_CHAIN_IDS = new Set(supportedChainIds);

const SUPPORTED_CHAIN_OPTIONS = CHAIN_OPTIONS.filter(
  (c) => CHAIN_SELECTOR_TO_ID[c.id] !== undefined,
);

export function PoolPageContent({ forcedPoolAsset }: { forcedPoolAsset?: string } = {}) {
  const tabClearance = useTabBarClearance();
  const focused = useIsFocused();
  const { width } = useWindowDimensions();
  const { address, isConnected, status: walletStatus } = useAccount();
  const router = useRouter();
  const { identityMode } = usePoolSession();
  const supportedChainCount = getSupportedChains().length;
  const multiChain = supportedChainCount >= 2;
  const { connectWallet } = useSupportedWalletConnection();
  // isSui reflects the ACTIVE chain, which this page selects to be the pool's
  // chain (below). The connect gate is EVM-specific (connectWallet opens the
  // wagmi picker), so on a Sui pool we skip it and let the Sui deposit modal
  // drive its own connect — otherwise a Sui user would get the EVM picker.
  const { activeChainId, selectChain, isSui: isSuiChain, isStellar } = useChainRouter();
  // Non-EVM pools (Sui, Stellar) drive their own wallet connect.
  const isSui = isSuiChain || isStellar;

  // Same gating as my-privacy-pools: clicking Deposit/Withdraw/Transfer/Request
  // while disconnected should kick off the wallet-connection flow and then
  // open the originally-requested modal once the connection resolves.
  const gated = <T,>(action: () => T) => async () => {
    if (!isSui && !isConnected) {
      try {
        await connectWallet();
      } catch {
        // User cancelled — still open the modal so they can see context.
      }
    }
    action();
  };

  const { switchChain } = useSwitchChain();
  // The wallet's ACTUAL chain: useAccount().chainId (the connector). Raw
  // useChainId() is the wagmi store, which does not follow the connector, so
  // the switch prompt below fired spuriously or not at all when they split.
  // Disconnected, fall back to the store (switchChain then just moves it).
  const { chainId: connectorChainId } = useAccount();
  const storeChainId = useChainId();
  const walletChainId = connectorChainId ?? storeChainId;
  const { data, statistics } = usePools();
  // Live USDC-per-ppUSDC: a share pool prints the USDC it is worth (Pat, 2026-09-05).
  const { rateFor } = useShareRates();
  const balanceDisplay = useBalanceDisplay();
  const { openDepositModal } = useDepositModal();
  const { openWithdrawModal } = useWithdrawModal();
  const { openTransferModal } = useTransferModal();
  const { openSwapModal } = useSwapModal();
  const { openRequestPaymentModal } = usePaymentRequestModal();
  // Off the public-feed grid. The unscoped getAllPrices() this replaces keyed a
  // cache scope the scheduler never warms, so opening a pool page fetched, and
  // so did every window focus past its staleTime. This page can also be showing
  // a SUI pool, whose id is not in the warmed set at all — another reason to
  // read what is already on the grid rather than ask for a scope.
  const priceMap = useAllChainsPriceMap(activeChainId);
  const isMobile = width < 768;
  // Below this width the four action buttons can't fit on a single row
  // without truncating ("Dep…" / "Wit…"), so wrap into 2 rows of 2.
  const compactButtons = width < 540;
  // My Privacy Pools + the action panel sit side by side at 50/50 above this
  // width. Below it each half would be ~350px — narrower than the pools table
  // needs — so they stack full-width instead.
  const stackPair = width < 900;
  const { chainName: routeChainName, poolAssetName: routeAssetName, action: routeAction } = useLocalSearchParams<{ chainName: string; poolAssetName: string; action?: string }>();
  const poolAssetName = forcedPoolAsset ?? routeAssetName;
  const defaultSelectorChain = defaultChainId === 11155111 ? 'sepolia' : 'eth';
  // The header's chain control starts on the ROUTE's chain (/chains/citrea/...
  // must not open showing Sepolia) and follows the route when it changes.
  const routeSelectorChain = (routeChainName ?? '').toLowerCase();
  const initialSelectorChain = CHAIN_SELECTOR_TO_ID[routeSelectorChain] ? routeSelectorChain : defaultSelectorChain;
  const [selectedChain, setSelectedChain] = useState<string>(initialSelectorChain);
  useEffect(() => { setSelectedChain(initialSelectorChain); }, [initialSelectorChain]);

  const handleChainSelect = (selectorId: string) => {
    const targetChainId = CHAIN_SELECTOR_TO_ID[selectorId];
    // Another chain than this pool's: go home, then switch, like the header
    // selector. Switching in place was undone by the pin effect below, with a
    // second wallet prompt and the card left naming the other chain (DEV-453).
    if (targetChainId && mustLeavePoolPageToSwitch({
      targetChainId,
      targetChainType: getChainConfig(targetChainId)?.chainType,
      currentChainId: poolChainId,
      pathname: '/chains/',
    })) {
      router.replace('/');
      void selectChain(targetChainId);
      return;
    }
    setSelectedChain(selectorId);
    if (targetChainId && targetChainId !== walletChainId && WAGMI_SUPPORTED_CHAIN_IDS.has(targetChainId)) {
      switchChain({ chainId: targetChainId as typeof walletChainId });
    }
  };

  // The route segment is a SLUG, not a symbol: on a chain with a share pool
  // `eth` is ppETH and the emptied plain pool is `eth-legacy` (config/pool-paths).
  const slugChain = getSupportedChains().find(
    (c) => c.chainType === 'evm' && c.name.toLowerCase() === (routeChainName ?? '').toLowerCase(),
  );
  const currentPoolToken = poolSymbolFromRoute(poolAssetName || 'eth', slugChain?.id ?? defaultChainId);

  // Split screen, new themes only — Classic keeps the stacked page verbatim.
  // Same shape as the vault home: action widget on the left, the pool's data
  // in a column on the right. There is no open/close transition here because
  // nothing opens — on a pool page the data is the page.
  const splitLayout = Platform.OS === 'web' && width >= SPLIT_MIN_WIDTH;
  // Measured width of the data column, so the tables inside size to IT and not
  // to the window (see explore-panel-context).
  const [dataColumnWidth, setDataColumnWidth] = useState(0);
  // Seeds the shield widget with the pool you are looking at. Re-pins whenever
  // the route's pool changes; a later pill press inside the widget writes here
  // and is left alone, so switching asset in the widget still works.
  const [selection, setSelection] = useState<PanelSelection>(EMPTY_SELECTION);
  const selectAsset = useCallback((next: SelectAssetInput) => {
    setSelection({
      assetSymbol: next.assetSymbol,
      poolId: next.poolId ?? null,
      chainId: next.chainId ?? null,
    });
  }, []);
  const pinnedPoolRef = useRef<string | null>(null);
  useEffect(() => {
    if (pinnedPoolRef.current === currentPoolToken) return;
    pinnedPoolRef.current = currentPoolToken;
    // The XLM pool names its chain, so the shield widget opens on that pool
    // instead of the EVM fallback.
    const pinnedChainId = currentPoolToken === 'XLM' ? STELLAR_TESTNET_ID : null;
    setSelection({ assetSymbol: currentPoolToken, poolId: null, chainId: pinnedChainId });
  }, [currentPoolToken]);
  // A pool detail page is a chain context: select the pool's chain so the
  // events/stats and the Deposit/Withdraw actions target it (not whatever chain
  // happened to be active). Sui selection is debug-gated in ChainProvider.
  // The chain comes from the ROUTE segment when it names an enabled EVM chain
  // (/chains/citrea/cbtc must select Citrea, not the build default); unknown
  // or absent segments (legacy links, forcedPoolAsset embeds) keep the default.
  const routeChain = getSupportedChains().find(
    (c) => c.chainType === 'evm' && c.name.toLowerCase() === (routeChainName ?? '').toLowerCase(),
  );
  // Single-asset non-EVM pools map straight to their chain.
  const nonEvmPoolChainId = currentPoolToken === 'SUI' ? SUI_TESTNET_ID : currentPoolToken === 'XLM' ? STELLAR_TESTNET_ID : null;
  const poolChainId = nonEvmPoolChainId ?? (routeChain?.id ?? defaultChainId);
  // Unknown chain segment, or an asset this chain has no token for: a
  // not-found state (rendered below, and the deep link stays inert), never a
  // plausible "DOGE Pool" built from fallback data. /chains/sui (no chain
  // segment) and a known chain's /sui stay valid; /chains/nowhere/sui does not.
  const routeChainKnown = !routeChainName || !!routeChain;
  const poolRouteKnown = routeChainKnown
    && (nonEvmPoolChainId !== null || !!getTokenMetadataBySymbol(currentPoolToken, poolChainId));
  // Once per visit, not on every chain change. Re-selecting whenever the active
  // chain differed made the page fight any other pick: the user choosing OP in
  // the header, or the wallet moving because ANOTHER tab of the site switched
  // it (MetaMask keeps one network per site), snapped straight back to the
  // route's chain and switched the wallet with it (Mike, 2026-09-28: "OP keeps
  // flipping back to Mainnet").
  // Keyed by the connection too: a visitor who arrives signed out and then
  // connects a wallet on another chain gets the route's chain asked for again.
  const chainPickedForRef = useRef<string | null>(null);
  useEffect(() => {
    // Stack routes stay mounted after departure. Only the active, valid pool
    // may choose the app-wide chain; retained pages must not fight the user.
    if (!focused) { chainPickedForRef.current = null; return; }
    const pickKey = `${poolChainId}:${isConnected}`;
    if (!poolRouteKnown || chainPickedForRef.current === pickKey) return;
    // Not while wagmi is still reconnecting: the pick would commit on the
    // disconnected fast path, the reconnect would then move the selection to
    // the wallet's chain, and the spent pick would never ask again.
    if (walletStatus === 'connecting' || walletStatus === 'reconnecting') return;
    chainPickedForRef.current = pickKey;
    if (poolChainId !== activeChainId) void selectChain(poolChainId);
  }, [focused, poolRouteKnown, poolChainId, activeChainId, walletStatus, isConnected, selectChain]);
  // Deep-link intent: `?action=deposit|withdraw` (used by the All Pools kebab)
  // opens the matching modal ONCE the pool's chain is active, so the modal
  // opens in the pool's chain context rather than racing the chain switch.
  const actionHandledRef = useRef(false);
  useEffect(() => {
    if (!focused || actionHandledRef.current) return;
    if (routeAction !== 'deposit' && routeAction !== 'withdraw') return;
    // A not-found route must not open a modal on the fallback token.
    if (!poolRouteKnown) return;
    if (activeChainId !== poolChainId) return;
    // Wait for wagmi to settle: while it is still reconnecting the modal's
    // connection gate sees "not connected", opens the wallet picker instead,
    // and the once-only intent is burned (the deep link silently did nothing).
    if (walletStatus === 'connecting' || walletStatus === 'reconnecting') return;
    actionHandledRef.current = true;
    // The route names the pool: open on ITS token, not the chain default.
    if (routeAction === 'deposit') openDepositModal({ tokenSymbol: currentPoolToken });
    else openWithdrawModal(undefined, { tokenSymbol: currentPoolToken });
  }, [focused, routeAction, poolRouteKnown, activeChainId, poolChainId, walletStatus, currentPoolToken, openDepositModal, openWithdrawModal]);
  // Stage-aware actions: with no SPENDABLE funds in any pool there's nothing
  // to withdraw or transfer yet. Tri-state and fail-open (see
  // services/action-gate.ts): exact ACTIVE balances only (pending isn't
  // spendable; sub-display dust still counts), loading balances never
  // disable, and the connection check is the active-chain one so Sui
  // sessions gate too. Request needs no funds and stays active.
  const { isConnected: activeChainConnected } = useMultiChainWallet();
  const { isLoading: notesLoading } = useNotes();
  const actionsDisabled = fundedActionsDisabled({
    connected: activeChainConnected,
    balancesLoading: notesLoading,
    // ACTIVE chain only: myPools spans chains now, and funds elsewhere must not
    // enable Withdraw/Transfer on a chain where the user holds nothing
    // (kimi review, finding 4).
    activeBalancesExact: data.myPools
      .filter((pool) => pool.chainId === activeChainId)
      .map((pool) => pool.balanceTokenExact),
  });
  // (Second useNotes() call below reuses the same provider-backed state.)

  const userPoolBalance = useMemo(() => {
    // Chain-matched (myPools spans chains): this page is about ONE pool on
    // one chain, so a same-symbol row from elsewhere must not answer for it.
    const poolEntry = data.myPools.find(
      (pool) => sameSymbol(pool.name, currentPoolToken) && pool.chainId === poolChainId,
    );
    // Exact strings, not the rounded display text: "<0.01 ppUSDC" parsed to 0.
    const activeExact = poolEntry?.balanceTokenExact ?? '0';
    const pendingExact = poolEntry?.pendingTokenExact ?? '0';
    const activeNum = parseFloat(activeExact) || 0;
    const pendingNum = parseFloat(pendingExact) || 0;
    const totalNum = activeNum + pendingNum;
    // A share pool shows the USDC its shares are worth (and prices THAT); the
    // share count only until the rate has been read. The route's own token
    // address answers when the visitor holds nothing here yet, so an empty
    // ppUSDC page still reads "0.00 USDC" under its "USDC Pool" title. The
    // price map has no entry for "PPUSDC", which is why the dollar line said $0.
    const shareAddress = poolEntry?.tokenAddress ?? getTokenMetadataBySymbol(currentPoolToken, poolChainId)?.address;
    const shareRate = rateFor(poolChainId, shareAddress);
    // The headline names the coin the figure is in: the underlying when the
    // rate is known, the share's own symbol when it is not, so a share count is
    // never printed as "ETH" (a 0.1 ETH shield read "0.09989 ETH", a fee look).
    const shareSymbol = poolEntry?.name ?? getTokenMetadataBySymbol(currentPoolToken, poolChainId)?.symbol ?? currentPoolToken;
    const priceFallback = priceMap[currentPoolToken] || 0;
    const activeView = shareBalanceDisplay({ sharesExact: activeExact, shareSymbol, rate: shareRate, priceMap, fallbackPrice: priceFallback });
    const pendingView = shareBalanceDisplay({ sharesExact: pendingExact, shareSymbol, rate: shareRate, priceMap, fallbackPrice: priceFallback });
    const converted = !!shareRate && activeView.converted && pendingView.converted;
    const price = converted ? underlyingPriceFor(shareRate, priceMap) : priceFallback;
    // What ONE unit of the pool token (a share) is worth in USD: the action
    // panel prices raw share amounts with it, so it carries the rate.
    const unitPrice = converted
      ? Number(formatUnits(shareRate.assetsPerShare, shareRate.underlyingDecimals)) * price
      : price;
    const progressPct = totalNum > 0 ? Math.round((activeNum / totalNum) * 100) : 0;
    return { activeNum, pendingNum, totalNum, price, unitPrice, progressPct, activeView, pendingView };
  }, [currentPoolToken, poolChainId, data.myPools, priceMap, rateFor]);

  // Every figure below is scoped to (symbol, chain): the feed spans chains, so
  // a same-symbol pool or transaction elsewhere must not count for this page.
  const isPoolTx = useCallback(
    (tx: { asset: string; chainId?: number }) => sameSymbol(tx.asset, currentPoolToken) && tx.chainId === poolChainId,
    [currentPoolToken, poolChainId],
  );
  const poolSpecificStats = useMemo(() => {
    const poolEntry = data.allPools.find((p) => sameSymbol(p.name, currentPoolToken) && p.chainId === poolChainId);
    const tvlUsd = poolEntry?.poolValue ?? '$0';
    // The share pool's TVL sub-line in the underlying it is worth, share count until the rate is read.
    const tvlRate = rateFor(poolChainId, getTokenMetadataBySymbol(currentPoolToken, poolChainId)?.address);
    const tvlShares = poolEntry?.poolValueTokenAmount ?? Number.NaN;
    const tvlToken = poolEntry
      ? (tvlRate && Number.isFinite(tvlShares)
        ? formatShareAsUnderlying(shareNumberAsUnderlying(tvlShares, tvlRate), tvlRate)
        // The ASP's compact figure carries the SHARE's symbol; rename it and
        // mark it approximate rather than printing ppUSDC (Pat, 2026-09-12).
        : approxUnderlyingText(poolEntry.poolValueToken, currentPoolToken))
      : `0 ${displayTokenSymbol(currentPoolToken)}`;

    const pendingTxs = data.transactions.filter(
      (tx) => isPoolTx(tx) && tx.type === 'Deposit' && tx.status === 'pending',
    );
    const pendingUsd = pendingTxs.reduce((sum, tx) => sum + tx.usdValue, 0);
    const pendingToken = pendingTxs.reduce((sum, tx) => sum + tx.tokenAmount, 0);

    let depositCount = 0;
    let withdrawalCount = 0;
    let transferCount = 0;
    let sumDepositUsd = 0;
    let sumDepositToken = 0;
    for (const tx of data.transactions) {
      if (!isPoolTx(tx)) continue;
      if (tx.type === 'Deposit') { depositCount += 1; sumDepositUsd += tx.usdValue; sumDepositToken += tx.tokenAmount; }
      else if (tx.type === 'Withdrawal' || tx.type === 'Exit') withdrawalCount += 1;
      else if (tx.type === 'Transfer') transferCount += 1;
    }
    const avgDepositUsd = depositCount > 0 ? sumDepositUsd / depositCount : 0;
    // The ASP has no chain-scoped statistics endpoint, so the SUI pool would
    // otherwise inherit the global (Sepolia) Deposits/Average/Withdrawals. Use
    // the SUI-specific counts derived from the chain-102 events instead, and
    // compute Total funds accepted from them (the ASP pool-stats row is $0).
    const isSui = currentPoolToken === 'SUI' || currentPoolToken === 'XLM';
    // Stellar deposits are not in the ASP events feed this total reads, so any
    // XLM figure here would be a false zero: show a dash until a Stellar
    // index feeds it.
    const fundsAccepted = currentPoolToken === 'XLM'
      ? '\u2014'
      : isSui ? formatUsd(sumDepositUsd) : (poolEntry?.fundsAccepted ?? '$0');

    return { tvlUsd, tvlToken, fundsAccepted, pendingUsd, pendingToken, depositCount, withdrawalCount, transferCount, avgDepositUsd, isSui };
  }, [currentPoolToken, poolChainId, isPoolTx, data.allPools, data.transactions, rateFor]);

  const { notes } = useNotes();

  // Aave yield (A5, flag-gated): quiet APY chip in the header + accrued yield
  // under the balance. Active only when this pool's asset is the configured
  // yield underlying for the pool's chain; zero-state renders nothing.
  // Matched against EVERY vault on the chain, not just the first: mainnet has
  // ppUSDC and ppUSDT, and comparing the pool symbol to deployment[0] left the
  // USDT pool page with no yield line at all (codex, 2026-09-04).
  // The share pool (/ppusdc) is the Aave position, not the legacy plain-USDC
  // pool (/usdc): match the ROUTE token to the deployment's share address.
  const routeTokenAddress = getTokenMetadataBySymbol(currentPoolToken, poolChainId)?.address?.toLowerCase();
  const poolYieldDeployment = currentPoolToken === 'SUI' || currentPoolToken === 'XLM' || !routeTokenAddress
    ? undefined
    : getConfiguredYieldDeployments(poolChainId)
      .find((d) => d.ppUSDC.toLowerCase() === routeTokenAddress);
  const poolYieldActive = !!poolYieldDeployment;
  // previewRedeem is already in the underlying: name it from the deployment,
  // not from the share-rate request that may still be loading.

  const myPoolActivity = useMemo(() => {
    // Wallet-mode only, like pools-provider's myDeposits gating: in account-key
    // mode the connected wallet is merely the PAYER, so using its address as
    // the depositor fallback (or as the self-payment viewer) would count that
    // wallet's unrelated activity as the key account's (codex, round 2).
    const connected = identityMode === 'wallet' ? address?.toLowerCase() : undefined;
    const noteTxHashes = new Set<string>();
    const noteLabels = new Set<string>();
    const noteCommitments = new Set<string>();
    for (const n of notes) {
      if (n.txHash) noteTxHashes.add(String(n.txHash).toLowerCase());
      const label = n.label ? normalizeCommitment(String(n.label)) : null;
      if (label) noteLabels.add(label);
      const commitment = normalizeCommitment(String(n.commitment ?? ''));
      if (commitment) noteCommitments.add(commitment);
    }
    const paidRequestTxHashes = buildPaidRequestTxHashSet(connected ?? null);
    const outgoingDepositTxHashes = buildOutgoingDepositTxHashSet(connected ?? null);
    // Count the SAME merged rows the table below shows. A lineage spend row
    // replaces the ASP spend row with the same tx hash; otherwise a fee row can
    // leave the table correct while this strip still counts the raw ASP Transfer
    // it replaced.
    // Merged BEFORE the pool filter, so a swap folds in its output's Deposit
    // row even when only one leg is in this pool.
    const mineEvents: typeof data.transactions = [];
    for (const tx of data.transactions) {
      const txMatch = !!tx.txHash && noteTxHashes.has(tx.txHash.toLowerCase());
      const labelMatch = !!tx.label && noteLabels.has(normalizeCommitment(tx.label) ?? '');
      if (tx.type === 'Deposit') {
        // Ownership, not authorship: a "Pay via Wallet" payment is a deposit
        // SUBMITTED by this wallet for someone else, so the address match alone
        // counted money the user gave away. Same test the balance and the
        // global counts use.
        const mine = isMyDeposit(
          { txHash: tx.txHash, depositor: tx.fullAddress },
          { ownedCommitments: noteCommitments, paidRequestTxHashes, outgoingDepositTxHashes, connectedAddress: connected || null },
        ) && !(tx.txHash && (data.depositOwnership.notMine.has(tx.txHash.toLowerCase()) || data.depositOwnership.pending.has(tx.txHash.toLowerCase())));
        if (mine || txMatch) mineEvents.push(tx);
      } else if ((txMatch || labelMatch) && !isInternalSpendRow(tx, data.internalTxHashes)) {
        mineEvents.push(tx);
      }
    }
    const mergedRows = mergeMyTransactions(mineEvents, data.lineageRows, data.anchorTxHashes)
      .filter((tx) => anyLeg(tx, isPoolTx));
    const countedTxHashes = new Set<string>();
    let deposits = 0;
    let withdrawals = 0;
    let transfers = 0;
    for (const tx of mergedRows) {
      // Per pool, a swap is what it was to each pool: value left the source
      // pool and a deposit landed in the output pool.
      if (isSwapRow(tx)) {
        if (isPoolTx(tx)) withdrawals += 1;
        // An output still delivering is not a deposit yet.
        if (isPoolTx(tx.swapOut) && !tx.swapOut.delivering) deposits += 1;
        continue;
      }
      const dedupeKey = tx.txHash ? `${tx.type}:${tx.txHash.toLowerCase()}` : null;
      if (dedupeKey && countedTxHashes.has(dedupeKey)) continue;
      if (tx.type === 'Deposit') {
        deposits += 1;
        if (dedupeKey) countedTxHashes.add(dedupeKey);
      } else if (tx.type === 'Withdrawal' || tx.type === 'Exit') {
        withdrawals += 1;
        if (dedupeKey) countedTxHashes.add(dedupeKey);
      } else if (tx.type === 'Transfer') {
        transfers += 1;
        if (dedupeKey) countedTxHashes.add(dedupeKey);
      }
    }
    return { deposits, withdrawals, transfers };
  }, [address, identityMode, isPoolTx, data.transactions, data.lineageRows, data.anchorTxHashes, data.internalTxHashes, notes]);

  const poolOptions = useMemo<PoolOption[]>(() => {
    return data.allPools.filter((pool) => {
      const held = data.myPools.find((p) => p.chainId === pool.chainId && p.tokenAddress.toLowerCase() === pool.tokenAddress.toLowerCase());
      return poolVisible({
        superseded: isSupersededLegacyPool(pool.name, pool.chainId),
        active: Number(held?.balanceTokenExact ?? 0),
        pending: Number(held?.pendingTokenExact ?? 0),
        current: pool.chainId === poolChainId && sameSymbol(pool.name, currentPoolToken),
      });
    }).map((pool) => ({
      id: pool.id,
      name: pool.name,
      tvl: pool.poolValue,
      icon: tokenIconFor(pool.name),
      chainId: pool.chainId,
      chainKey: getChainConfig(pool.chainId)?.name.toLowerCase() ?? '',
    }));
  }, [data.allPools, data.myPools, poolChainId, currentPoolToken]);

  const poolAccounts = useMemo<PoolAccount[]>(() => {
    return data.myPools.map((pool, i) => ({
      name: `${poolDisplayLabel(pool.name, pool.chainId)} Pool`,
      icon: tokenIconFor(pool.name),
      // Was EthTokenIcon for every row, so an OP/Citrea/BNB pool account wore
      // Ethereum's mark (same family as the selector icons Artem reported,
      // 2026-08-28). myPools spans chains, so resolve per row.
      chainId: pool.chainId,
      balance: pool.balance,
      pendingValue: pool.pending,
      ethBalance: balanceDisplay(pool.balanceTokenExact, pool.name, pool.chainId, pool.tokenAddress).text,
      scoreColor: SCORE_COLORS[Math.min(i % 3, 2)],
      filledDots: Math.min(pool.poolAccounts, 3),
      total: pool.balance,
    }));
  }, [data.myPools, balanceDisplay]);

  // A share pool is named by its underlying: "USDC Pool", not "PPUSDC Pool".
  const poolName = `${poolDisplayLabel(currentPoolToken, poolChainId)} Pool`;

  const currentPoolMetadata = useMemo(() => {
    const symbol = currentPoolToken;
    // Scope to the PAGE's chain: /chains/citrea/cbtc must resolve Citrea's
    // native token, not fall back to mainnet ETH. Last resort is the chain's
    // own native asset (always registered), never another chain's.
    return getTokenMetadataBySymbol(symbol, poolChainId)
      ?? getTokenMetadata(NATIVE_ASSET_ADDRESS, poolChainId);
  }, [currentPoolToken, poolChainId]);
  // This pool exists and holds notes, but has not opened for deposits yet
  // (mainnet ETH). Withdraw / Transfer / Request are untouched — only the way
  // in is shut, so only Deposit is disabled.
  const depositComingSoon = currentPoolMetadata.depositComingSoon === true;
  // Live on-chain net APY when this pool's asset is a yield-bearing share
  // (ppUSDC / ppUSDT on prod). Null for a plain asset, so the header chip stays off.
  const poolShareYield = useShareYield({
    chainId: poolChainId,
    tokenAddress: poolSpecificStats.isSui ? undefined : currentPoolMetadata.address,
  });

  // Pool-SCOPED statistics (asp-v2 PR #92 per-asset endpoint). Review P1: the
  // card must never read median/transfers from the global payload — that is
  // the protocol-wide aggregate and would render the same figure on every
  // pool page. 404s today; every dependent row is omitted until it deploys.
  const { assetStats } = useAssetStatistics({
    // The ROUTE's chain, not the app chain: the first render happens before
    // the chain-pin effect runs, and asking the ASP for another chain's asset
    // is a guaranteed 404 (mainnet has no statistics registration).
    chainId: poolChainId,
    tokenAddress: poolSpecificStats.isSui ? undefined : currentPoolMetadata.address,
  });

  const [chartPeriod, setChartPeriod] = useState<TimePeriod>('30D');
  const portfolioSeries = usePortfolioHistory({
    tokenAddress: currentPoolMetadata.address,
    decimals: currentPoolMetadata.decimals,
    period: chartPeriod,
  });
  // Pool ids are `${chainId}:${symbol}`, so the route's bare symbol is matched
  // on (name, chain) here; falling back to poolOptions[0] would show the first
  // pool's TVL under this page's title.
  const activePool: PoolOption = poolOptions.find((p) => sameSymbol(p.name, currentPoolToken) && p.chainId === poolChainId)
    ?? { id: `${poolChainId}:${currentPoolToken.toLowerCase()}`, name: currentPoolToken, tvl: poolSpecificStats.tvlUsd, icon: tokenIconFor(currentPoolToken), chainId: poolChainId, chainKey: routeSelectorChain };

  const handleConnectWallet = () => {
    connectWallet();
  };

  /**
   * The action panel's only way out. Every action re-enters the SAME `gated()`
   * wrapper the card's action bar uses above, so the disconnected case (kick
   * off the wallet-connection flow, then open the modal either way) and the
   * Sui case (`!isSui && !isConnected` — never pop the EVM picker on Sui,
   * bccccfd) behave identically whichever surface the user pressed. The panel
   * itself never touches a modal provider.
   *
   * Swap is the one deliberate exception, matching my-privacy-pools.tsx: the
   * swap modal owns its own connection gate (wallet OR account-key session),
   * so wrapping it in gated() would force the wagmi picker onto key sessions.
   */
  const launchPanelAction = (action: PoolPanelAction, amount: string) => {
    const initialAmount = amount || undefined;
    // The panel and every modal act on the ACTIVE chain, while this page only
    // asks for the route's chain in an effect: a pending or rejected wallet
    // switch leaves the two apart, and a figure typed against the route token
    // would land in a modal on another chain (codex on 16aca5c). Ask for the
    // switch again and hand nothing over until they agree, exactly like the
    // ?action= deep link above.
    if (activeChainId !== poolChainId) {
      selectChain(poolChainId);
      return;
    }
    switch (action) {
      case 'deposit':
        // Pool not open for deposits yet: the provider refuses the open with
        // the same sentence, so nothing here needs to duplicate the copy.
        void gated(() => openDepositModal({ tokenSymbol: currentPoolToken, initialAmount }))();
        return;
      case 'withdraw':
        void gated(() => openWithdrawModal(undefined, { tokenSymbol: currentPoolToken, amount: initialAmount }))();
        return;
      case 'transfer': {
        // The transfer modal forces SUI in Sui mode; every registered EVM token
        // passes through, shares included (a three-symbol whitelist used to drop
        // ppUSDC, so the modal kept its previous asset for the prefilled amount).
        const transferToken = !isSui && getTokenMetadataBySymbol(currentPoolToken, poolChainId) ? currentPoolToken : undefined;
        void gated(() => openTransferModal({
          ...(isSui || !transferToken ? {} : { tokenSymbol: transferToken }),
          amount: initialAmount,
        }))();
        return;
      }
      case 'swap': {
        // The swap modal falls back to the chain's first routeable asset when the
        // pool token has no swap route (a share, prod plain USDC) and says so, but
        // a prefilled amount would ride along onto that asset at its precision
        // (codex on fe21a7f). Hand the amount over only for a real swap input.
        // Same list and same resolution the swap modal uses, through the shared
        // rule rather than a copy of it: this line read `t.symbol ===
        // currentPoolToken.toUpperCase()`, which no mixed-case share symbol can
        // satisfy, so a share pool never handed its amount over either.
        const request = { tokenAddress: currentPoolMetadata.address, tokenSymbol: currentPoolToken };
        const swappable = !!resolveHandoffToken(request, getSwapInputTokens(activeChainId));
        openSwapModal({ ...request, ...(swappable ? { initialAmount } : {}) });
        return;
      }
      case 'request':
        void gated(() => openRequestPaymentModal())();
        return;
    }
  };

  if (!poolRouteKnown) {
    const chainLabel = routeChain?.displayName ?? routeChainName ?? getChainConfig(poolChainId)?.displayName ?? 'this chain';
    return (
      <View className="flex-1 bg-background" testID="pool-not-found">
        <Header />
        <View className="flex-1 items-center justify-center p-[20px]">
          <Card className="w-full max-w-[420px] items-center gap-[12px] p-[24px]">
            <Text className="text-[20px] text-text font-pp-medium">Pool not found</Text>
            <Text className="text-center text-[14px] text-text-secondary font-pp-regular">
              There is no {displayTokenSymbol(currentPoolToken)} pool on {chainLabel}.
            </Text>
            <Pressable
              className="mt-[8px] h-[36px] items-center justify-center rounded-control border border-border bg-button-primary px-[20px]"
              onPress={() => router.replace('/explore')}
              accessibilityRole="button"
              testID="pool-not-found-explore"
            >
              <Text className="text-[14px] text-button-primary-text font-pp-medium">Browse pools</Text>
            </Pressable>
          </Card>
        </View>
      </View>
    );
  }

  return (
    <ExplorePanelProvider
      // 'page' keeps the data components on their normal table layouts; only
      // the measured width changes, so they fit the narrower right-hand column.
      surface="page"
      width={splitLayout ? dataColumnWidth : 0}
      selection={selection}
      selectAsset={selectAsset}
    >
    <View className="flex-1 bg-background">
      <Header />
      <ScrollView
        className="flex-1"
        contentContainerClassName="grow overflow-visible px-[20px] pt-[20px]"
        // nw-keep(measured-or-inset): clearance for the floating bottom bar
        contentContainerStyle={{ paddingBottom: 20 + tabClearance }}
      >
        <View
          // row-reverse while split: the shield widget keeps its place in DOM
          // order (primary control — focus and reading order follow it) but
          // paints on the RIGHT, matching My balances and the home split.
          className={`mx-auto w-full gap-[20px] overflow-visible${splitLayout ? ' flex-row-reverse items-start' : ' grow'}`}
          // nw-keep(measured-or-inset): the band widens for the two-column split; single-column keeps the original 960 cap
          style={{ maxWidth: splitLayout ? SPLIT_MAX_WIDTH : 960, ...(splitLayout ? { gap: SPLIT_GAP } : null) }}
        >
        {/* The shield widget, seeded with this pool's asset. It replaces the
            per-pool action panel that used to sit beside My Privacy Pools
            below. Same actions, one place. First in DOM order, painted on the
            right by the row-reverse above. */}
        {splitLayout && (
          <View
            className="gap-[20px]"
            // nw-keep(measured-or-inset): fixed widget column of the split band
            // (SPLIT_LEFT_WIDTH is the shared constant's name, not its side)
            style={{ width: SPLIT_LEFT_WIDTH }}
          >
            <ActionHub />
          </View>
        )}

        <View
          className={`gap-[20px] overflow-visible${splitLayout ? ' flex-1' : ' w-full'}`}
          onLayout={splitLayout ? (e) => setDataColumnWidth(e.nativeEvent.layout.width) : undefined}
        >
          {/* Desktop: `items-stretch` so the balance card and the Statistics
              card share one height (the taller sets it; the balance card's
              `flex-1` centred body absorbs the slack). Mobile stays stacked
              and content-height. */}
          <View className={`${poolCardsRowClassName(isMobile)} gap-[20px] overflow-visible z-[100]`}>
            <Card
              noPadding
              testID="pool-balance-card"
              // Mobile keeps flex-[2] (not just w-full): the original RN style
              // was [{flex:2},{flex:undefined,width:'100%'}], and RN's flatten
              // SKIPS the undefined, so flex:2 survived on mobile too. Dropping
              // it to flex:0-0-auto shrank the card, so the flex-1 infoCard no
              // longer stretched (justify-center padding), shifting content up.
              className={`${isMobile ? 'w-full flex-[2]' : 'flex-[2]'} z-[100]`}
              // nw-keep(forwarded-style-contract): caller-last style overrides Card's overflow:hidden (dropdown stacking) — no reliable className override path
              style={{ overflow: 'visible' }}
            >
              <PoolPageHeader
                poolName={poolName}
                activePool={activePool}
                poolOptions={poolOptions}
                multiChain={multiChain}
                supportedChainOptions={SUPPORTED_CHAIN_OPTIONS}
                selectedChain={selectedChain}
                onSelectChain={handleChainSelect}
                yieldApy={poolYieldActive ? poolShareYield.yield?.netApyPercent ?? YIELD_APY_PERCENT ?? undefined : undefined}
              />
              <View className="flex-[3] items-center justify-center gap-[20px] p-[20px]">
                <View className="items-center gap-[4px]">
                  <Text className="text-[12px] leading-[12px] text-[#4D4D4D] font-pp-regular">
                    My Private Balance
                  </Text>
                  <View className="flex-row items-center gap-[6px]">
                    <Text testID="pool-private-balance" className="text-[24px] text-text font-pp-bold">
                      {userPoolBalance.activeView.text}
                    </Text>
                    <ShareCountHint hint={userPoolBalance.activeView.hint} testID="pool-private-balance-hint" />
                  </View>
                  <Text className="text-[12px] leading-[12px] text-[#4D4D4D] font-pp-regular">
                    ${userPoolBalance.activeView.usd.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                  </Text>
                </View>
                <View className="items-center gap-[4px]">
                  <Text className="text-[12px] leading-[12px] text-[#4D4D4D] font-pp-regular">
                    Pending Balance
                  </Text>
                  <View className="flex-row items-center gap-[4px]">
                    <Text className="text-[12px] leading-[12px] text-[#4D4D4D] font-pp-bold">
                      {userPoolBalance.pendingView.text}
                    </Text>
                    <ShareCountHint hint={userPoolBalance.pendingView.hint} testID="pool-pending-balance-hint" />
                  </View>
                </View>
              </View>
              {/* "My activity": the personal deposit / withdrawal / transfer
                  counts for this pool. Bottom quarter of the card (flex 1 vs
                  the balance body's flex 3). Counts are the same merged rows
                  the transactions table shows; disconnected reads as a dash
                  rather than a misleading 0. */}
              <View
                testID="pool-my-activity"
                className="flex-[1] justify-center gap-[8px] border-t px-[12px] py-[10px] border-border"
              >
                <Text className="text-[11px] leading-[14px] text-text-secondary font-pp-regular">
                  My activity
                </Text>
                <View className="flex-row items-center">
                  {myActivityCells(myPoolActivity, isConnected).map(({ label, value }, i) => (
                    <Fragment key={label}>
                      {i > 0 && <View className="w-[1px] self-stretch bg-border" />}
                      <View className="flex-1 items-center gap-[4px]">
                        <Text className="text-[11px] leading-[14px] text-text-secondary font-pp-regular">
                          {label}
                        </Text>
                        <Text className="text-[14px] leading-[16px] text-text font-pp-bold">
                          {value}
                        </Text>
                      </View>
                    </Fragment>
                  ))}
                </View>
              </View>
              <View className="relative h-[1px] self-stretch z-[-1] bg-border" />
              {/* Desktop split screen: the shield widget in the left column
                  already offers Deposit/Withdraw/Transfer/Request for this
                  pool, so repeating them under the balance is the same control
                  twice on one screen. Kept on the stacked layout, which has no
                  shield widget. */}
              {!splitLayout && (
                <View
                  testID="pool-balance-actions"
                  className={`flex-row items-center gap-[8px] p-[12px]${compactButtons ? ' flex-wrap' : ''}`}
                >
                  <Pressable
                    className={`flex-1 h-[34px] items-center justify-center rounded-control border px-[20px] py-[4px] bg-button-primary border-border${compactButtons ? ' basis-[48%]' : ''} ${depositComingSoon ? 'opacity-40' : 'opacity-100'}`}
                    onPress={gated(() => openDepositModal({ tokenSymbol: currentPoolToken }))}
                    disabled={depositComingSoon}
                    testID="pool-deposit-action"
                  >
                    <Text numberOfLines={1} className="text-[14px] text-center text-button-primary-text font-pp-medium">
                      Deposit
                    </Text>
                  </Pressable>
                  <Pressable
                    className={`flex-1 h-[34px] items-center justify-center rounded-control border px-[20px] py-[4px] bg-card-background border-border${compactButtons ? ' basis-[48%]' : ''} ${actionsDisabled ? 'opacity-40' : 'opacity-100'}`}
                    onPress={gated(() => openWithdrawModal(undefined, { tokenSymbol: currentPoolToken }))}
                    disabled={actionsDisabled}
                  >
                    <Text numberOfLines={1} className="text-[14px] text-center text-text font-pp-medium">
                      Withdraw
                    </Text>
                  </Pressable>
                  <Pressable
                    className={`flex-1 h-[34px] items-center justify-center rounded-control border px-[20px] py-[4px] bg-card-background border-border${compactButtons ? ' basis-[48%]' : ''} ${actionsDisabled ? 'opacity-40' : 'opacity-100'}`}
                    onPress={gated(() => openTransferModal({ tokenSymbol: currentPoolToken }))}
                    disabled={actionsDisabled}
                  >
                    <Text numberOfLines={1} className="text-[14px] text-center text-text font-pp-medium">
                      Transfer
                    </Text>
                  </Pressable>
                  <Pressable
                    className={`flex-1 h-[34px] items-center justify-center rounded-control border px-[20px] py-[4px] bg-card-background border-border${compactButtons ? ' basis-[48%]' : ''}`}
                    onPress={gated(() => openRequestPaymentModal())}
                  >
                    <Text numberOfLines={1} className="text-[14px] text-center text-text font-pp-medium">
                      Request
                    </Text>
                  </Pressable>
                </View>
              )}
              {/* The pool exists and holds notes — only the way IN is not open
                  yet. Say so under the actions rather than leaving a dead
                  button unexplained. */}
              {!splitLayout && depositComingSoon && (
                <Text
                  testID="pool-deposit-coming-soon"
                  className="px-[12px] pb-[12px] text-[12px] text-center text-text-muted font-pp-regular"
                >
                  {comingSoonDepositMessage(currentPoolToken, getChainConfig(poolChainId)?.displayName)}
                </Text>
              )}
            </Card>

            <PoolPageStatsCard
              isMobile={isMobile}
              statistics={poolSpecificStats.isSui ? null : statistics}
              assetStats={poolSpecificStats.isSui ? null : assetStats}
              tvlUsd={poolSpecificStats.tvlUsd}
              tvlToken={poolSpecificStats.tvlToken}
              fundsAccepted={poolSpecificStats.fundsAccepted}
              depositCount={poolSpecificStats.depositCount}
              avgDepositUsd={poolSpecificStats.avgDepositUsd}
              withdrawalCount={poolSpecificStats.withdrawalCount}
              transferCount={poolSpecificStats.transferCount}
            />
          </View>

          {/* Equal-width, equal-height pair. Wide: two `flex-1` children in a
              `flex-row` are exactly 50/50 (flex-basis 0), and the row's default
              align-items: stretch gives both cards the SAME height. The taller
              one sets it, the panel's `grow`/centred body absorbs the slack, and
              the pools table's `grow` absorbs it on the other side, so neither
              half carries a dead strip. Narrow: full-width stacked, content
              height (each branch owns width outright. Never a base + partial
              override, which would resolve by CSS emission order). The
              108ff39 / cb297f0 mobile flex distribution belongs to the
              balance/stats pair ABOVE and is untouched. */}
          {/* In split mode the action panel is gone — the shield widget in the
              left column already carries Deposit/Withdraw/Transfer/Request for
              this pool — and the asset strip is gone too: the pool header card
              above already states the private balance, so the MyPrivacyPools
              list above the transactions table said it twice (QA 2026-08-17). */}
          {splitLayout ? null : (
            <View className={`${stackPair ? 'flex-col' : 'flex-row items-stretch'} gap-[20px] overflow-visible z-[10]`}>
              <MyPrivacyPools className={stackPair ? 'w-full' : 'flex-1'} compact={!stackPair} hideHero />
              <PoolActionPanel
                poolToken={currentPoolToken}
                tokenPriceUsd={userPoolBalance.unitPrice}
                depositPriceUsd={userPoolBalance.price}
                depositSymbol={displayTokenSymbol(currentPoolToken)}
                depositDecimals={poolYieldDeployment?.underlyingDecimals}
                actionsDisabled={actionsDisabled}
                narrow={stackPair}
                onLaunch={launchPanelAction}
              />
            </View>
          )}

          <View className="relative z-[1]">
            {/* DEV-220: removed the "Portfolio Net Value" chart + "My Assets"
                accounts grid from the pool-specific page. Portfolio-level
                content doesn't belong here. */}
            <Transactions mode="full" assetFilter={currentPoolToken} chainFilter={poolChainId} />
          </View>
          {Platform.OS === 'web' && !splitLayout && <Footer />}
        </View>
        </View>
        {Platform.OS === 'web' && splitLayout && (
          <View className="mx-auto w-full max-w-[960px] mt-[24px]">
            <Footer />
          </View>
        )}
      </ScrollView>
      {Platform.OS !== 'web' && (
        <View className="px-[20px] pb-[20px]">
          <Footer />
        </View>
      )}
    </View>
    </ExplorePanelProvider>
  );
}
