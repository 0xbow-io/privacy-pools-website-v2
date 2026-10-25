import { syncingLabel } from '@/services/chain-sweep';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getPoolPath, poolDisplayLabel } from '@/config/pool-paths';
import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { useCardLayout, useExplorePanel, useLayoutWidth } from '@/components/home/explore-panel-context';
import { useChainRouter } from '@/hooks/use-chain-router';
import { useRouter } from 'expo-router';
import Svg, { Path, Circle } from 'react-native-svg';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Card } from '@/components/ui/card';
import { ChainBadge, TokenNetworkIcon } from '@/components/ui/token-network-icon';
import { Skeleton } from '@/components/ui/skeleton';
import { ShareApyChip } from '@/components/yield/share-apy-chip';
import { approxUnderlyingText, displayTokenSymbol, isShareSymbol } from '@/services/share-display';
import { shareExactAsUnderlying, underlyingPriceFor } from '@/services/share-rates';
import { formatUsd } from '@/services/format-fiat';
import { useShareRates } from '@/hooks/use-share-rates';
import { shareBalanceDisplay } from '@/services/share-balance-display';
import { ShareCountHint } from '@/components/pools/share-count-hint';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { usePools } from '@/components/pools-provider';
import { useMultiChainWallet } from '@/hooks/use-multi-chain-wallet';
import { useNotes } from '@/hooks/use-notes';
import { useWalletUnlockGate } from '@/hooks/use-wallet-unlock-gate';
import { usePoolSession } from '@/hooks/use-pool-session';
import { useSessionChainId } from '@/hooks/use-session-chain-id';
import { readUnanchoredCommitments } from '@/services/unanchored-notes-store';
import { useNoteImport } from '@/hooks/use-note-import';
import { useSeedDerivationModal } from '@/components/seed-derivation-modal-provider';
import { useKeystoreRegistrationModal } from '@/components/keystore-registration-modal-provider';
import { claimCalloutVisible } from '@/services/funds-state';
import { bestConsolidation } from '@/services/consolidate-notes';
import { getKnownTokenMetadata } from '@/config/tokens';
import { supportedEvmChainIds } from '@/config/chains';
import { useTransferFeeEstimate } from '@/hooks/use-transfer-fee-estimate';
import { useTransferModal, type TransferPrefill } from '@/components/transfer-modal-provider';
import { useConsolidationStart } from '@/hooks/use-consolidation-start';
import { consolidatableNotesOn } from '@/components/consolidation-asset-list';
import type { Note } from '@/services/sdk-types';
import { SuiTokenMark } from '@/components/ui/sui-token-mark';
import { FinishSetupBanner } from '@/components/home/finish-setup-banner';
import { AccountUnlockNotice } from '@/components/account-unlock-help';
import { getChainConfig } from '@/config/chains';

// --- Token Icons ---
// nw-keep(svg-or-canvas): the fill/stroke props on every icon below are artwork
// colors (brand token literals) baked into the SVG — no className path.

function EthIcon({ size = 16 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <Circle cx={10} cy={10} r={10} fill="#627EEA" />
      <Path d="M10 4L10 8.5L13.5 10L10 4Z" fill="#C0CBF6" />
      <Path d="M10 4L6.5 10L10 8.5L10 4Z" fill="white" />
      <Path d="M10 12.5L10 16L13.5 10.75L10 12.5Z" fill="#C0CBF6" />
      <Path d="M10 16L10 12.5L6.5 10.75L10 16Z" fill="white" />
      <Path d="M10 11.75L13.5 10L10 8.5L10 11.75Z" fill="#8197EE" />
      <Path d="M6.5 10L10 11.75L10 8.5L6.5 10Z" fill="#C0CBF6" />
    </Svg>
  );
}

function DaiIcon({ size = 16 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <Circle cx={10} cy={10} r={10} fill="#F5AC37" />
      <Path d="M6 10H14M6 8H14M10 4L6 10L10 16L14 10L10 4Z" stroke="white" strokeWidth={1} />
    </Svg>
  );
}

function WethIcon({ size = 16 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <Circle cx={10} cy={10} r={10} fill="#EC1C79" />
      <Path d="M10 4L10 8.5L13.5 10L10 4Z" fill="#F8A4CC" />
      <Path d="M10 4L6.5 10L10 8.5L10 4Z" fill="white" />
      <Path d="M10 12.5L10 16L13.5 10.75L10 12.5Z" fill="#F8A4CC" />
      <Path d="M10 16L10 12.5L6.5 10.75L10 16Z" fill="white" />
    </Svg>
  );
}



/** Symbols the shared TokenNetworkIcon draws (token mark + chain badge). */
const SHARED_MARK_SYMBOLS = new Set(['ETH', 'USDC', 'USDT', 'SUI', 'BNB', 'CBTC']);

const POOL_ICONS: Record<string, (props: { size?: number }) => React.JSX.Element> = {
  ETH: EthIcon,
  DAI: DaiIcon,
  WETH: WethIcon,
  SUI: SuiTokenMark,
};


/**
 * How long the Syncing marker stays up after the last active sync flag.
 *
 * Sized from measurement, not taste. A real load showed two quiet windows
 * between phases, 1071ms and 581ms, so a 1200ms grace covered them with only
 * 11% headroom - a slower machine or a slower ASP would flicker again. 2500ms
 * covers the observed worst case more than twice over and still clears promptly
 * after a sync that genuinely ends (the marker sits beside a real figure, so
 * holding it a beat too long costs nothing; dropping it too early is the bug).
 */
const SYNC_MARKER_GRACE_MS = 2_500;

export function MyPrivacyPools({
  className = '',
  compact = false,
  hideHero = false,
}: {
  /**
   * Extra layout classes for the card — used by the pool page to make this
   * one half of an equal-width/equal-height pair (`flex-1`).
   */
  className?: string;
  /**
   * Half-width presentation: the five-up count stats can't hold a 24px figure
   * each in ~420px, so a compact card keeps the two BALANCES and drops the
   * counts. Table columns are trimmed for every width (see below).
   */
  compact?: boolean;
  /**
   * Drop the balance hero and render only the asset list. The pool page has
   * its own "My Private Balance" header above this card, so the hero would be
   * the same figure twice on one screen.
   */
  hideHero?: boolean;
} = {}) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  // Column decisions follow the CONTAINER, not the window: in the desktop
  // split screen this component renders into ~55% of the viewport. Falls back
  // to the window width outside a panel shell (Classic pools page).
  const width = useLayoutWidth();
  const { data, isLoading: poolsLoading } = usePools();
  // Live USDC-per-ppUSDC so a share row prints the USDC it is worth, with the
  // share named in a hint (Pat, 2026-09-05: "38.10 ppUSDC" should read as USDC).
  const { rateFor } = useShareRates();

  const isMobile = width <= 450;
  // Deposits/Transfers/Withdrawals counts: full-width card only (a compact
  // half-width card keeps just the two balance figures).
  const stats = data.myPoolsStats;
  const pools = data.myPools;
  // Every pool is listed. It used to cap at four behind a "Show all my Privacy
  // Pools" footer, which hid a funded pool behind a control people did not read
  // as one (Mike, 2026-09-24). The card-level collapse above still hides it all.
  const visiblePools = pools;
  // Stage-aware actions: with no SPENDABLE funds in any pool there's nothing
  // to withdraw or transfer yet. Tri-state and fail-open (see
  // services/action-gate.ts): exact ACTIVE balances only (pending isn't
  // spendable; sub-display dust still counts), loading balances never
  // disable, and the connection check is the active-chain one so Sui
  // sessions gate too. Disconnected users keep active buttons (they route
  // through the connect flow); Request needs no funds and stays active.
  const { isConnected: activeChainConnected } = useMultiChainWallet();
  // Panel presence still drives selected-row styling (the shield widget can set
  // the selection); pressing a row navigates to its pool page either way.
  const panel = useExplorePanel();
  const selectedSymbol = panel?.selection.assetSymbol ?? null;
  // Stacked cards instead of a wide table in the mobile sheet.
  const cardLayout = useCardLayout();
  const { isLoading: notesLoading, notes } = useNotes();
  // An active keystore sync is also a loading state for the figures: a just
  // signed-in account shows 0 for several seconds while discovery runs.
  const { isSyncing, syncChainsLeft, isInitializing, isInitialized, keysReady, error: sessionError, sessionAddress, keystoreIdentityStatus } = usePoolSession();
  const sessionChainId = useSessionChainId();
  // Same flow the receipt page runs; the notes are already in the local store, so
  // the link is not needed to anchor them, only to have got them here.
  const { importOnChain, busy: anchorBusy, errMessage: anchorError } = useNoteImport();
  /** Last real total, so a momentary empty pools list cannot blank the figure. */
  const lastFigureRef = useRef<string | null>(null);
  /**
   * ...but only for THIS account. The bridge above is a within-account device,
   * and it does not survive a wallet switch: the provider tears the session and
   * notes down the moment the address changes, so the new account's pools list
   * is empty for several seconds, and the bridge happily filled that window
   * with the PREVIOUS wallet's total. Pat signed in with a fresh 0 ETH wallet
   * and was shown the old wallet's balance (2026-08-27).
   *
   * Cleared during render, not in an effect: an effect runs after the render
   * that already read the ref, so the stale figure would still paint one frame.
   */
  const figureAccountRef = useRef<string | null | undefined>(undefined);
  const figureAccount = sessionAddress ?? null;
  if (figureAccountRef.current !== figureAccount) {
    figureAccountRef.current = figureAccount;
    lastFigureRef.current = null;
  }
  // The ACTIVE chain, not CHAIN_OPTIONS[0]: these balances belong to whatever
  // chain the app is on, and a link built without it falls back to the default
  // chain — which the pool page then pins the whole app to.
  const { activeChainId, isSui, isStellar } = useChainRouter();
  // A row on another network switches to it and opens the note picker once that
  // network has loaded. Held here, not in the row: the rows reload with the switch.
  const { openTransferModal } = useTransferModal();
  const { start: startConsolidation } = useConsolidationStart(openTransferModal);
  // Between the session key being restored and createSession finishing the
  // cached-account import, every loading flag is false but notes are still
  // empty — a 0 would flash before the real figure lands. Treat that init
  // window as loading too (unless init errored, so we don't dash forever).
  const sessionInitPending = !sessionError && (isInitializing || (keysReady && !isInitialized));

  /**
   * Syncing marker state, latched.
   *
   * The marker is an OR of five independent flags, and they GAP between phases:
   * a snapshot sync finishes a beat before discovery starts, every flag reads
   * false in that window, and the marker blinks off for about a second and comes
   * back (Pat, 2026-08-27). A figure that flickers its own status reads as a bug
   * even though the number is fine, so the marker latches: it appears the
   * instant any flag goes true and only clears after the flags have been quiet
   * for SYNC_MARKER_GRACE_MS.
   *
   * The transition log is deliberate. Which flag moved, and when, is the only
   * way to tell a real phase gap from a state bug, and guessing at that has cost
   * this session hours elsewhere. One line per change, behind the [perf] prefix
   * the rest of the tracing uses.
   */
  const syncingNow =
    poolsLoading || notesLoading || isSyncing || sessionInitPending || data.pricesLoading;
  const [syncingLatched, setSyncingLatched] = useState(syncingNow);
  const syncSignatureRef = useRef<string>('');
  /** When the current flag signature began, so the log can state gap DURATION. */
  const syncSignatureAtRef = useRef<number>(Date.now());
  useEffect(() => {
    const active = [
      poolsLoading ? 'poolsLoading' : null,
      notesLoading ? 'notesLoading' : null,
      isSyncing ? 'isSyncing' : null,
      sessionInitPending ? 'sessionInitPending' : null,
      data.pricesLoading ? 'pricesLoading' : null,
    ].filter(Boolean);
    const signature = active.join(',');
    if (signature !== syncSignatureRef.current) {
      const previous = syncSignatureRef.current;
      const heldMs = Date.now() - syncSignatureAtRef.current;
      syncSignatureRef.current = signature;
      syncSignatureAtRef.current = Date.now();
      try {
        // Duration is the point: a `none` window SHORTER than the grace is a
        // phase gap the latch hides, and one LONGER than it is a real flicker.
        // Without it the log showed gaps but could not say whether the user saw
        // them, which is the only question that matters.
        // Order matters, and I got it wrong first time: a `previous === ''`
        // guard came first and swallowed the gap case, so the one line worth
        // reading - how long a quiet window lasted and whether the user saw it -
        // never printed. Test the quiet-window END first.
        const verdict = previous === '' && signature !== '' && heldMs > 0
          ? ` (gap lasted ${heldMs}ms, ${heldMs < SYNC_MARKER_GRACE_MS ? 'HIDDEN by the latch' : 'VISIBLE as a flicker'})`
          : signature === ''
            ? ` (sync quiet; marker holds ${SYNC_MARKER_GRACE_MS}ms)`
            : '';
        console.log(
          `[perf] · balance-hero syncing=${syncingNow} flags=[${signature || 'none'}]`
          + ` held=${heldMs}ms prev=[${previous || 'none'}]${verdict}`,
        );
      } catch {
        // never let a diagnostic break rendering
      }
    }
    if (syncingNow) {
      setSyncingLatched(true);
      return;
    }
    const timer = setTimeout(() => setSyncingLatched(false), SYNC_MARKER_GRACE_MS);
    return () => clearTimeout(timer);
  }, [
    syncingNow,
    poolsLoading,
    notesLoading,
    isSyncing,
    sessionInitPending,
    data.pricesLoading,
  ]);
  // Returning tab: notes rehydrated from the tab cache (so the balance
  // renders), but the session keystore isn't rebuilt without a fresh
  // signature — nothing re-syncs (no incoming-transfer discovery, no
  // pending→active promotion) and the figure is frozen at the last sync.
  // The balance stays useful, so annotate it with a sign-in affordance that
  // triggers the re-sync instead of gating the card. The shared gate keeps
  // this to genuinely locked WALLET sessions (settled wagmi connection,
  // wallet identity mode, EVM); a failed account-key init instead gets a
  // direct retry, never the wallet-signature prompt.
  const { requiresWalletUnlock: evmRequiresUnlock, keyInitFailed, retryKeyInit, stellarLocked, unlockStellar } = useWalletUnlockGate();
  const { openSeedDerivationModal: openEvmSignIn } = useSeedDerivationModal();
  // Stellar's locked session wears the same sign-in affordance; its action is
  // the Freighter unlock, not the EVM signature modal.
  const requiresWalletUnlock = evmRequiresUnlock || stellarLocked;
  const openSeedDerivationModal = stellarLocked ? unlockStellar : () => openEvmSignIn();
  const cachedLocked = (requiresWalletUnlock || keyInitFailed) && notes.length > 0;
  // Claim: this wallet holds a positive private balance it cannot spend until
  // its keystore is registered (a received payment, typically). One callout
  // here, the rows themselves carry the Claim badge (services/funds-state.ts).
  const { status: registrationStatus, openKeystoreRegistrationModal } = useKeystoreRegistrationModal();
  // From the notes, not the pool rows: `MyPool.balance` is a USD string and
  // reads -e wherever the price feed has no quote (testnets), which hid the
  // callout for a real 0.0002 ETH receipt.
  const hasSpendable = notes.some((n) => {
    if (String(n.status).toUpperCase() !== 'ACTIVE') return false;
    try { return BigInt(n.value) > 0n; } catch { return false; }
  });
  const showClaim = keysReady && claimCalloutVisible(registrationStatus, hasSpendable);

  // A SECOND, different question: do I hold value that is only reachable through
  // a receipt link?
  //
  // The callout above asks whether the WALLET is unregistered. That is not the
  // same thing, and Pat hit the gap on 2026-09-01: he imported a transfer receipt
  // device-only, was already registered, and My balances showed the money with no
  // way to act on it and nothing saying it was link-only. Close that tab without
  // the link and the balance is unreachable, silently.
  //
  // Note these notes ARE on-chain. The sender's transact created them. What they
  // are not is self-discoverable, which is what anchoring fixes, so the test
  // cannot be "is the commitment on-chain" (it is) and cannot be "did discovery
  // find it" (a stored note and a not-yet-run scan look identical). The flag is
  // recorded when the device-only path is taken and cleared only on a positively
  // confirmed anchor (services/unanchored-notes-store.ts).
  const unanchoredCommitments = readUnanchoredCommitments(sessionAddress, sessionChainId);
  const unanchoredNotes = unanchoredCommitments.size === 0 ? [] : notes.filter((n) => {
    if (String(n.status).toUpperCase() !== 'ACTIVE') return false;
    return unanchoredCommitments.has(String(n.commitment ?? '').toLowerCase());
  });
  // Both callouts can be true at once, and then they are two boxes whose
  // buttons go to the SAME place: an unregistered wallet holding a link-only
  // note needs registering AND anchoring, and the Claim flow already does both
  // (Pat, 2026-09-01, on the keystoreless run). So only one is ever shown. The
  // registration callout wins because it names the blocking condition, and it
  // absorbs the tab-only risk into its copy rather than dropping it, since that
  // risk is the data-loss warning and is the more urgent of the two facts.
  const unanchoredWhileUnregistered = showClaim && unanchoredNotes.length > 0;
  const showUnanchored = keysReady && unanchoredNotes.length > 0 && !showClaim;
  // Plain console so the e2e harness and CI logs can explain a missing callout.
  useEffect(() => {
    console.debug('[Claim] callout inputs', { keysReady, registrationStatus, hasSpendable, notes: notes.length, showClaim });
  }, [keysReady, registrationStatus, hasSpendable, notes.length, showClaim]);

  const router = useRouter();

  // Routes to the ROW's own chain: with multichain balances a Citrea row used
  // to open the ACTIVE chain's page for that symbol (kimi review, finding 8).
  const getPoolRoute = useCallback(
    (poolName: string, chainId: number) =>
      getPoolPath(poolName, chainId) as Parameters<typeof router.push>[0],
    [],
  );

  return (
    // Chromeless root: the mock puts the balance straight on the page, with
    // only the asset list in a card. `className` still lets the pool page size
    // it (w-full / flex-1).
    <View testID="my-privacy-pools-card" className={`gap-[14px] overflow-visible z-[100] ${className}`}>
      {!isSui && !isStellar && keysReady && keystoreIdentityStatus === 'incompatible' ? (
        <AccountUnlockNotice network={getChainConfig(sessionChainId)?.displayName ?? 'this network'} />
      ) : null}
      {/* Cached-balance refresh: the figure below is a frozen tab-cache
          snapshot; only the sign-in that rebuilds the keystore can actually
          re-sync it. Kept (the header that used to host it is gone). */}
      {cachedLocked && hideHero && (
        <Pressable
          className="self-start"
          accessibilityLabel="Sync balances"
          onPress={() => (keyInitFailed ? retryKeyInit() : openSeedDerivationModal())}
          accessibilityRole="button"
        >
          <Text className="font-pp-regular text-[11px] underline text-text-secondary">
            {keyInitFailed ? 'Retry sync' : 'Sign in to sync'}
          </Text>
        </Pressable>
      )}
      <FinishSetupBanner />
      {showClaim && (
        <View
          testID="claim-callout"
          className="flex-row items-center gap-[8px] rounded-inner border border-border-light bg-warning-bg px-[12px] py-[10px]"
        >
          {/* nw-keep(data-color): warning glyph color is a theme token into the @expo/vector-icons sink (no className path) */}
          <Ionicons name="gift-outline" size={14} color={colors.warning} />
          <Text className="flex-1 font-pp-regular text-[12px] text-text">
            {unanchoredWhileUnregistered
              ? 'Funds received, saved in this tab only. Register to keep and spend them.'
              : 'Funds received. Register this wallet to spend them.'}
          </Text>
          <Pressable
            className="rounded-control bg-button-primary px-[14px] py-[6px]"
            accessibilityRole="button"
            onPress={() => openKeystoreRegistrationModal({
              title: 'Claim your funds',
              // The relayer line replaces "It needs a little gas in this
              // wallet": for the case this modal actually serves, an
              // unregistered wallet with no gas, the relayer pays and takes its
              // fee from the note instead, so the old sentence was wrong there.
              // Naming the fee up front is the point - a tester claiming 0.001
              // ETH lost 55% of it to the fixed gas term with no warning.
              body: 'A one-time on-chain setup makes what you received spendable. A relayer submits it for you, so your address stays private. Its fee is 0.1% plus gas.',
              primaryLabel: 'Register and claim',
            })}
          >
            <Text className="font-pp-medium text-[12px] text-button-primary-text">Claim</Text>
          </Pressable>
        </View>
      )}
      {showUnanchored && (
        <View
          testID="unanchored-callout"
          className="flex-row items-center gap-[8px] rounded-inner border border-border-light bg-warning-bg px-[12px] py-[10px]"
        >
          {/* nw-keep(data-color): warning glyph color is a theme token into the @expo/vector-icons sink (no className path) */}
          <Ionicons name="alert-circle-outline" size={14} color={colors.warning} />
          <Text className="flex-1 font-pp-regular text-[12px] text-text">
            {unanchoredNotes.length === 1
              ? 'One payment is saved in this tab only. Add it on-chain to keep it.'
              : `${unanchoredNotes.length} payments are saved in this tab only. Add them on-chain to keep them.`}
          </Text>
          <Pressable
            className="rounded-control bg-button-primary px-[14px] py-[6px]"
            accessibilityRole="button"
            disabled={anchorBusy}
            onPress={() => { void importOnChain(unanchoredNotes as never, { expectedChainId: sessionChainId }); }}
          >
            <Text className="font-pp-semi-bold text-[12px] text-button-primary-text">
              {anchorBusy ? 'Adding…' : 'Add on-chain'}
            </Text>
          </Pressable>
        </View>
      )}
      {showUnanchored && anchorError ? (
        <Text className="font-pp-regular text-[11px] leading-[16px] text-warning">{anchorError}</Text>
      ) : null}
      <>
      {/* Locked session: the figures below come from public/snapshot data
          (deposits) or a frozen cache. The full balance needs the keystore.
          Same banner idiom as My activity. */}
      {/* Only where the hero is absent: with the hero on screen the sign-in
          affordance sits inline next to the figure (Pat, 2026-08-28), and two
          Sign in buttons for one action is one too many. */}
      {(requiresWalletUnlock || keyInitFailed) && notes.length === 0 && hideHero && (
        <View className="flex-row items-center gap-[8px] border-b border-b-border-light px-[16px] py-[10px]">
          {/* nw-keep(data-color): lock glyph color is a theme token into the @expo/vector-icons sink (no className path) */}
          <Ionicons name="lock-closed-outline" size={14} color={colors.textSecondary} />
          <Text className="flex-1 font-pp-regular text-[12px] text-text-secondary">
            Sign in to sync your balances
          </Text>
          <Pressable
            className="rounded-control bg-button-primary px-[14px] py-[6px]"
            accessibilityRole="button"
            accessibilityLabel="Sync balances"
            onPress={() => (keyInitFailed ? retryKeyInit() : openSeedDerivationModal())}
          >
            <Text className="font-pp-medium text-[12px] text-button-primary-text">
              {keyInitFailed ? 'Retry' : 'Sign in'}
            </Text>
          </Pressable>
        </View>
      )}
      {/* Hero (mock): the balance leads. While anything it depends on is still
          loading a literal $0 is a FALSE zero. Skeleton until real. */}
      {hideHero ? null : (() => {
        /**
         * Show the figure we already have, and say it is still syncing.
         *
         * This used to skeleton the total for the whole of a sync, which made
         * the balance go BACKWARDS (Pat, 2026-08-27): a reload showed $535 from
         * cache, then sign-in replaced it with a skeleton for ~20s while
         * discovery ran and found nothing new - all while the ETH row directly
         * underneath kept showing 0.2131 ETH / $535, from the same data. The
         * skeleton was never protecting the user from anything; it was hiding a
         * number the page was already rendering three centimetres lower.
         *
         * So the skeleton is now only for a genuinely cold state, with nothing
         * to show. `lastFigure` keeps the last real figure across a moment where
         * the pools list empties (which is what produced the sign-in flicker),
         * and the syncing marker is the honest part: a figure is on screen, and
         * an update may still land.
         */
        // Latched upstream, so a gap between sync phases cannot blink the marker.
        const syncing = syncingLatched;
        // Every row hidden as emptied (DEV-466) is a known zero, not an unloaded list.
        const hasFigure = (pools.length > 0 || (data.hiddenEmptyPools ?? 0) > 0) && Number.isFinite(stats.acceptedFundsUsd);
        if (hasFigure) lastFigureRef.current = stats.acceptedFundsValue;
        /**
         * An empty pools list means two different things, and the bridge must
         * only cover one of them. MID-SYNC it means "not loaded yet", so hold
         * the last real figure. SETTLED, with a session on screen, it means the
         * account genuinely holds nothing — and the honest answer there is the
         * computed zero, never a figure carried over from before. Uses the raw
         * flags, not the latched marker: the latch adds a cosmetic grace period
         * for the spinner and must not decide what number is true.
         */
        const settledEmpty = !syncingNow && !!sessionAddress;
        const shownFigure = hasFigure || settledEmpty
          ? stats.acceptedFundsValue
          : lastFigureRef.current;
        /**
         * A skeleton is a promise that a number is coming. Signed out, none is,
         * and the old code left the placeholder shimmering forever after a
         * sign-out (Pat, 2026-08-27). The resting state there is a dash.
         *
         * "Loading" is not enough on its own to make that promise. A wallet that
         * is merely CONNECTED but not signed in reports notesLoading forever
         * (no session will ever initialise unsolicited), which brought the
         * endless skeleton straight back under a different address. The promise
         * is only honest while a session is actually being built or is already
         * built, so the skeleton needs that too.
         */
        const sessionExpected = isInitializing || keysReady || isInitialized;
        const figuresPending = !shownFigure && syncingNow && sessionExpected;
        return (
          <View className="gap-[2px]">
            {/* Sentence case, muted — the mock's quiet label over a loud figure. */}
            <Text className="font-pp-sans-medium text-[13px] leading-[18px] text-text-secondary">
              My private balance
            </Text>
            {figuresPending ? (
              <View className="h-[56px] justify-center">
                <Skeleton width={240} height={40} />
              </View>
            ) : (
              <View className="flex-row items-center gap-[10px]">
                <Text numberOfLines={1} className="font-pp-bold text-[46px] leading-[56px] tracking-[-1px] text-text">
                  {/* The app's empty-value dash (audit view, swap modal), for
                      the signed-out resting state. */}
                  {shownFigure ?? '—'}
                </Text>
                {/* Locked session: the figure is a frozen cache and NOTHING is
                    syncing until the user signs in, yet this slot said
                    "Syncing" (Pat, 2026-08-28). The honest annotation is the
                    sign-in itself, inline where the eye already is — the
                    full-width banner above only covers the no-figure case now. */}
                {(requiresWalletUnlock || keyInitFailed) ? (
                  <View className="flex-row items-center gap-[8px]">
                    {/* nw-keep(data-color): lock glyph color is a theme token into the @expo/vector-icons sink (no className path) */}
                    <Ionicons name="lock-closed-outline" size={14} color={colors.textSecondary} />
                    <Text className="font-pp-sans-medium text-[12px] text-text-secondary">
                      Sign in to sync
                    </Text>
                    <Pressable
                      className="rounded-control bg-button-primary px-[14px] py-[6px]"
                      accessibilityRole="button"
                      accessibilityLabel="Sync balances"
                      onPress={() => (keyInitFailed ? retryKeyInit() : openSeedDerivationModal())}
                    >
                      <Text className="font-pp-medium text-[12px] text-button-primary-text">
                        {keyInitFailed ? 'Retry' : 'Sign in'}
                      </Text>
                    </Pressable>
                  </View>
                ) : syncing && shownFigure && sessionExpected ? (
                  /* The marker means "a figure is on screen and an update may
                     still land". That is only true with a session building or
                     built; beside the signed-out dash (or a locked cache)
                     nothing is landing, and a spinner there reads exactly like
                     the endless skeleton it replaced. */
                  <View className="flex-row items-center gap-[5px]" accessibilityLabel="Syncing your balance">
                    {/* nw-keep(data-color): spinner tint is a theme token into
                        RN's ActivityIndicator (no className path). */}
                    <ActivityIndicator size="small" color={colors.textSecondary} />
                    <Text className="font-pp-sans-medium text-[12px] text-text-secondary">{syncingLabel(syncChainsLeft)}</Text>
                  </View>
                ) : null}
              </View>
            )}
          </View>
        );
      })()}

      {/* The asset list is the only card in the mock: rounded, hairline
          border, rows divided by thin rules. `grow` keeps the pool page's
          equal-height pair absorbing slack here as before. */}
      <Card noPadding className="grow overflow-visible px-[4px] py-[4px] z-[1]">
        {/* No column header — the mock is a clean asset list (dot · symbol,
            amount, USD), not a table. Labels lived above BALANCE/PENDING; the
            values read for themselves now. */}

        {/* Empty state — wallet not connected, or connected but no
            deposits / pending notes yet. Text only: the action bar that used to
            follow it is gone (see below), so the next step comes from the
            shield widget / bottom bar rather than from inside this card. */}
        {pools.length === 0 && (
          <View className="items-center justify-center py-[32px]">
            {/* Locked: an empty list says nothing about the account yet. */}
            <Text className="font-pp-regular text-[13px] text-center text-text-secondary">
              {!isSui && !isStellar && keysReady && keystoreIdentityStatus === 'incompatible'
                ? 'Use your original unlock to see this account’s assets.'
                : requiresWalletUnlock
                ? 'Sign in to see your assets.'
                : (data.hiddenEmptyPools ?? 0) > 0 ? 'No private balance right now.' : 'Your assets will show up here once you deposit.'}
            </Text>
          </View>
        )}

        {/* Table Rows */}
        {visiblePools.map((pool, index) => {
          // A yield share wears its UNDERLYING's mark: ppUSDC is USDC held a
          // certain way, and "ppUSDC" matched neither map, so the row wore the
          // ETH fallback (Pat, 2026-09-05).
          // A share's figures in its underlying at the live rate; the share
          // count stays as the fallback until the rate has been read.
          const shareRate = isShareSymbol(pool.name) ? rateFor(pool.chainId, pool.tokenAddress) : undefined;
          const converted = shareRate ? shareExactAsUnderlying(pool.balanceTokenExact, shareRate) : null;
          const convertedPending = shareRate ? shareExactAsUnderlying(pool.pendingTokenExact, shareRate) : null;
          const underlyingPrice = shareRate ? underlyingPriceFor(shareRate, data.priceMap) : 0;
          // A share with no rate yet keeps its count under the SHARE's own symbol
          // (balance and pending alike), never under the coin's name.
          const viewOf = (sharesExact: string) => shareBalanceDisplay({ sharesExact, shareSymbol: pool.name, rate: shareRate, priceMap: data.priceMap, fallbackPrice: 0 });
          const balanceView = isShareSymbol(pool.name) ? viewOf(pool.balanceTokenExact) : null;
          const pendingView = isShareSymbol(pool.name) ? viewOf(pool.pendingTokenExact) : null;
          const balanceText = balanceView ? balanceView.text : approxUnderlyingText(pool.balanceToken, pool.name);
          const pendingText = pendingView ? pendingView.text : approxUnderlyingText(pool.pendingToken, pool.name);
          // The dollar figures follow the SAME converted quantity, never shares × price.
          const balanceUsdText = converted != null && underlyingPrice > 0 ? formatUsd(converted * underlyingPrice) : pool.balance;
          const pendingUsdText = convertedPending != null && underlyingPrice > 0 ? formatUsd(convertedPending * underlyingPrice) : pool.pending;
          const markSymbol = displayTokenSymbol(pool.name).toUpperCase();
          const IconComponent = POOL_ICONS[markSymbol] || EthIcon;
          // Balances span chains (2026-08-18), so every row states its chain:
          // the shared mark badges it from chainId (and carries the testnet
          // pill). Assets the shared mark doesn't know keep their own logo
          // with the same badge overlaid.
          // A symbol with no local logo goes to the shared mark too: its letter
          // mark is honest, where the ETH glyph fallback put Ethereum on cBTC.
          const sharedMark = SHARED_MARK_SYMBOLS.has(markSymbol) || !POOL_ICONS[markSymbol];
          const PoolMark = ({ size }: { size: number }) => (sharedMark ? (
            <TokenNetworkIcon symbol={pool.name} size={size} chainId={pool.chainId} />
          ) : (
            /* nw-keep(measured-or-inset): square box sized to the caller's icon size */
            <View className="relative" style={{ width: size, height: size }}>
              <IconComponent size={size} />
              <ChainBadge size={Math.round(size * 0.46) + 2} chainId={pool.chainId} symbol={pool.name} />
            </View>
          ));
          const isSelected = !!panel && selectedSymbol === pool.name && pool.chainId === activeChainId;

          // Mobile sheet: one card per holding — icon + ticker top left,
          // shielded balance top right, USD value beneath it.
          if (cardLayout) {
            return (
              <Pressable
                key={pool.id}
                // Same as the table row: the card is a link to the pool page.
                onPress={() => router.push(getPoolRoute(pool.name, pool.chainId))}
                accessibilityRole="button"
                accessibilityState={panel ? { selected: isSelected } : undefined}
                testID={`my-pool-card-${pool.id}`}
                className={`mb-[8px] gap-[10px] rounded-inner border p-[12px] ${isSelected ? 'border-primary bg-primary-soft' : 'border-border-light bg-background-secondary'}`}
              >
                <View className="flex-row items-start justify-between gap-[12px]">
                  <View className="flex-row items-center gap-[8px]">
                    <PoolMark size={22} />
                    <Text className="font-pp-semi-bold text-[14px] text-text">{poolDisplayLabel(pool.name, pool.chainId)}</Text>
                    {/* Live net APY for a yield-bearing share (ppUSDC / ppUSDT); nothing for a plain asset. */}
                    <ShareApyChip chainId={pool.chainId} tokenAddress={pool.tokenAddress} testID={`my-pool-card-apy-${pool.id}`} />
                  </View>
                  <View className="items-end gap-[3px]">
                    <View className="flex-row items-center gap-[4px]">
                      <Text numberOfLines={1} className="font-pp-medium text-[14px] leading-[16px] text-text">
                        {balanceText}
                      </Text>
                      <ShareCountHint hint={balanceView?.hint ?? null} />
                    </View>
                    <Text numberOfLines={1} className="font-pp-regular text-[11px] leading-[13px] text-text-muted">
                      {balanceUsdText}
                    </Text>
                  </View>
                </View>
                {(parseFloat(pool.pendingTokenExact) || 0) > 0 && (
                  <View className="flex-row items-center justify-between gap-[12px] border-t border-border-light pt-[9px]">
                    <Text className="font-pp-regular text-[12px] leading-[16px] text-text-secondary">Pending</Text>
                    <View className="flex-row items-center gap-[4px]">
                      <Text numberOfLines={1} className="font-pp-regular text-[12px] leading-[16px] text-warning">
                        {pendingText} · {pendingUsdText}
                      </Text>
                      <ShareCountHint hint={pendingView?.hint ?? null} />
                    </View>
                  </View>
                )}
              </Pressable>
            );
          }

          return (
            <View key={pool.id} className="relative overflow-visible z-[1]">
              {/* 19 = the card's 24 radius less its 1 border and 4 padding, so a
                  highlighted row's corners stay concentric with the card's. */}
              <View
                className={`flex-row items-center gap-[8px] overflow-visible rounded-[19px]${
                  isSelected ? ' bg-primary-soft' : ''
                }`}
              >
                {/* Mock layout: colored token dot + bold symbol on the left,
                    token amount in the middle, USD value on the right. The
                    whole left cell stays the tap target (routes to the pool page);
                    pending rides as a small sub-line under the amount so the
                    row keeps ONE line of primary figures. */}
                <Pressable
                  className="flex-1 flex-row items-center gap-[10px] px-[8px] py-[12px]"
                  accessibilityRole="button"
                  accessibilityState={panel ? { selected: isSelected } : undefined}
                  testID={`my-pool-row-${pool.id}`}
                  // Always route to the asset's pool page, panel or not: the row
                  // reads as a link to that holding, and inside the panel a
                  // press that only re-pointed the shield widget looked inert.
                  onPress={() => router.push(getPoolRoute(pool.name, pool.chainId))}
                >
                  <View className="h-[26px] w-[26px] z-[1]">
                    <PoolMark size={26} />
                  </View>
                  <View className="min-w-[44px] gap-[1px]">
                    <Text numberOfLines={1} className="font-pp-semi-bold text-[14px] leading-[16px] text-text">
                      {poolDisplayLabel(pool.name, pool.chainId)}
                    </Text>
                  </View>
                  <ShareApyChip chainId={pool.chainId} tokenAddress={pool.tokenAddress} testID={`my-pool-row-apy-${pool.id}`} />
                  <View className="flex-1 gap-[2px]">
                    <View className="flex-row items-center gap-[4px]">
                      <Text numberOfLines={1} className="font-pp-regular text-[13px] leading-[15px] text-text-secondary">
                        {balanceText}
                      </Text>
                      <ShareCountHint hint={balanceView?.hint ?? null} />
                    </View>
                    {(parseFloat(pool.pendingTokenExact) || 0) > 0 && (
                      <View className="flex-row items-center gap-[4px]">
                        <Text numberOfLines={1} className="font-pp-regular text-[12px] leading-[16px] text-warning">
                          {pendingText} pending
                        </Text>
                        <ShareCountHint hint={pendingView?.hint ?? null} />
                      </View>
                    )}
                  </View>
                </Pressable>
                {/* USD value, right-aligned. The consolidate link sits here, outside
                    the row's button: a button cannot contain another button. */}
                <View className="items-end gap-[2px] px-[8px] py-[12px]">
                  <Text numberOfLines={1} className="font-pp-semi-bold text-[14px] leading-[16px] text-text">
                    {balanceUsdText}
                  </Text>
                  {keysReady && sessionAddress && !isSui && !isStellar && supportedEvmChainIds.includes(pool.chainId) && (
                    <ConsolidateLink chainId={pool.chainId} tokenAddress={pool.tokenAddress} testID={`consolidate-${pool.id}`}
                      activeChainId={activeChainId} activeNotes={notes} owner={sessionAddress} onStart={startConsolidation} />
                  )}
                </View>
              </View>
              {index < visiblePools.length - 1 && (
                <View className="relative h-[1px] self-stretch bg-border-light z-[-1]" />
              )}
            </View>
          );
        })}
      </Card>

      {/* The Deposit/Withdraw/Transfer/Swap/Request bar used to sit here. It is
          gone at every width: on desktop the shield widget beside this card
          already offers the same five actions, and duplicating them inside a
          balances card was the same control twice on one screen. On mobile the
          bottom bar and the action card carry them. */}

      </>
    </View>
  );
}

/**
 * Same-deposit dust: 2..5 small notes folded into one by a fee-only
 * self-transfer (services/consolidate-notes.ts), offered on the row of the
 * network that holds them. Another network's notes come from its stored
 * account export.
 */
function ConsolidateLink({ chainId, tokenAddress, testID, activeChainId, activeNotes, owner, onStart }: {
  chainId: number; tokenAddress: string; testID: string; activeChainId: number; activeNotes: Note[]; owner: string;
  onStart: (chainId: number, prefill: TransferPrefill) => void;
}) {
  const feeFor = useTransferFeeEstimate(chainId);
  const owned = useMemo(() => consolidatableNotesOn(chainId, activeChainId, activeNotes, owner), [chainId, activeChainId, activeNotes, owner]);
  const token = getKnownTokenMetadata(tokenAddress, chainId);
  const pick = token ? bestConsolidation(owned, tokenAddress, feeFor(tokenAddress)) : null;
  if (!token || !pick) return null;
  const start = () => onStart(chainId, { recipient: owner, tokenSymbol: token.symbol, inputCommitments: pick.notes.map((n) => n.commitment) });
  return (
    <Pressable onPress={start} accessibilityRole="button" testID={testID} hitSlop={6}>
      <Text numberOfLines={1} className="font-pp-sans-medium text-[10.5px] leading-[12px] text-tint underline">
        Consolidate notes
      </Text>
    </Pressable>
  );
}
