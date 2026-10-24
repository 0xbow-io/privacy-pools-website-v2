import { ShareCountHint } from '@/components/pools/share-count-hint';
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
import { useShareFreeBalanceDisplay } from '@/hooks/use-balance-display';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Platform, Pressable, Share, Text, View, type LayoutChangeEvent } from 'react-native';

import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { TokenNetworkIcon } from '@/components/ui/token-network-icon';

import { Card } from '@/components/ui/card';
import { useCollapsed } from '@/hooks/use-collapsed';
import { useNotes } from '@/hooks/use-notes';
import { useSessionChainId } from '@/hooks/use-session-chain-id';
import { findOwnAction } from '@/services/own-actions-store';
import { paidSessionRequestIds, type ReceivedNoteLike } from '@/services/session-request-fulfillment';
import { usePaymentRequestBackupModal } from '@/components/payment-request-backup-modal-provider';
import { useAccountRecoveryModal } from '@/components/account-recovery-modal-provider';
import { isStellarAccountAddress, stellarBlindRequestId } from '@/services/stellar/stellar-request';
import { usePaymentRequestModal } from '@/components/payment-request-modal-provider';
import { useRequestOwner } from '@/hooks/use-request-owner';
import { paginate } from '@/services/paginate';
import { exportAllPaymentRequests } from '@/services/payment-request-recovery';
import {
  buildPaymentRequestRows,
  type PaymentRequestListRow,
} from '@/services/payment-request-list';
import { listStoredPaymentRequests } from '@/services/payment-requests';
import { listSessionPaymentRequests, type SessionPaymentRequest } from '@/services/session-payment-requests';
import { formatUnits } from 'viem';
import {
  getPaymentRequestRevision,
  subscribePaymentRequestRevision,
} from '@/services/payment-request-revision';
import { getKnownTokenMetadata, getTokenMetadata, isStablecoin } from '@/config/tokens';
import { getChainConfig, STELLAR_TESTNET_ID } from '@/config/chains';
import { STELLAR_XLM } from '@/config/stellar-deployment';
import { PAY_URL_BASE } from '@/config/env';
import { isShareSymbol} from '@/services/share-display';
import { formatUsd } from '@/services/format-fiat';
import { priceFromMap } from '@/services/price-map-merge';
import { shareNumberAsUnderlying, underlyingPriceFor } from '@/services/share-rates';
import { usePools } from '@/components/pools-provider';
import { useShareRates } from '@/hooks/use-share-rates';
import { formatShortDate, formatShortTime } from '@/services/display-date';
import { useStellarSession } from '@/hooks/use-stellar-session';
import { stellarReceivedNotes } from '@/services/stellar-activity';
import { Pill, type PillTone } from '@/components/ui/pill';

type Filter = 'all' | 'open' | 'fulfilled';

/** Rows per page. Past ~a dozen the card stops being scannable. */
const REQUESTS_PER_PAGE = 10;

// Same base the create flow uses for share links (see
// payment-request-modal-provider shareLinkBase): production pins the brand
// domain; dev/preview stays on the rendering host.
/** One spelling per commitment (hex case and padding vary between the SDK and the activity rows). */
function commitmentKey(c: string): string {
  try { return BigInt(c).toString(16); } catch { return c.toLowerCase(); }
}

function linkBase(): string {
  if (PAY_URL_BASE) return PAY_URL_BASE;
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
  return '';
}

export function PaymentRequestsCard({
  surface = 'modal',
  onNavigateAway,
  hideWhenEmpty = false,
}: {
  /** 'page' renders nothing while signed out (quiet home placement);
   *  'modal' keeps the connect hint (the user explicitly opened it). */
  surface?: 'modal' | 'page';
  /** Called before an action that opens another modal (Re-issue) so a
   *  hosting modal can close itself first. */
  onNavigateAway?: () => void;
  /** Render nothing at all when this owner has no requests, instead of an
   *  empty card. For unprompted placements (the classic home) where an
   *  empty-state card is just noise. Deliberately NOT set for the manage modal
   *  or the activity drawer: the user opened those, so "none yet" is the
   *  answer they asked for. */
  hideWhenEmpty?: boolean;
} = {}) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  // One canonical SETTLED owner (key session wins; wallet only once wagmi is
  // 'connected') — the same identity the backup modal exports/imports.
  const { owner } = useRequestOwner();
  const ownerKey = owner?.toLowerCase() ?? null;
  // DEV-227: surface backup actions in the manage modal itself (not just the
  // header Actions menu) since the subtitle tells users to "use Export".
  const requestBackup = usePaymentRequestBackupModal();
  // A Stellar account's requests are in its request and account backups (the
  // EVM request backup reads SDK records Stellar does not have); the account
  // modal restores either file.
  const accountBackup = useAccountRecoveryModal();
  const stellarOwnerShown = !!owner && isStellarAccountAddress(owner);
  const openExportPaymentRequestsModal = stellarOwnerShown ? accountBackup.openExportNotesModal : requestBackup.openExportPaymentRequestsModal;
  const openImportPaymentRequestsModal = stellarOwnerShown ? accountBackup.openImportNotesModal : requestBackup.openImportPaymentRequestsModal;
  const { openRequestPaymentModal } = usePaymentRequestModal();

  // Reload whenever any store writer bumps the revision (discovery marking a
  // request FULFILLED, creation, import, migration) — without this a
  // fulfilled request would stay OPEN-with-copyable-link until remount.
  const revision = useSyncExternalStore(
    subscribePaymentRequestRevision,
    getPaymentRequestRevision,
    getPaymentRequestRevision,
  );

  // Rows are BOUND to the owner that produced them: on an owner switch the
  // stale rows are never rendered (loaded.owner no longer matches) even
  // before the new load resolves — wallet B must not see or act on wallet
  // A's rows during the async gap.
  const [loaded, setLoaded] = useState<{ owner: string; rows: PaymentRequestListRow[]; sessionRequests: SessionPaymentRequest[] } | null>(null);
  // Registered-wallet requests carry no request tag, so the SDK never marks
  // them paid. Read it off the notes this session already holds instead
  // (services/session-request-fulfillment.ts): local data, no request.
  const { notes } = useNotes();
  // Prices and share rates both come from the fixed public-feed grid, so
  // opening the card puts no request on the wire.
  const { data: poolsData } = usePools();
  const priceMap = poolsData?.priceMap;
  const { rateFor } = useShareRates();
  const balanceDisplay = useShareFreeBalanceDisplay();
  // The dollar line under each amount, priced like Activity rows: the row's
  // own chain's price, and a share at its underlying through the live rate.
  const usdLabel = useCallback((r: PaymentRequestListRow): string => {
    const amount = Number(r.amountFormatted);
    if (!priceMap || r.amountFormatted === '—' || !Number.isFinite(amount)) return '';
    if (isShareSymbol(r.assetSymbol)) {
      const rate = rateFor(r.chainId, r.tokenAddress);
      const price = rate ? underlyingPriceFor(rate, priceMap) : 0;
      return rate && price > 0 ? formatUsd(shareNumberAsUnderlying(amount, rate) * price) : '';
    }
    const price = priceFromMap(priceMap, { chainId: r.chainId, address: r.tokenAddress, symbol: r.assetSymbol })
      ?? (isStablecoin(r.assetSymbol) ? 1 : 0);
    return price > 0 ? formatUsd(amount * price) : '';
  }, [priceMap, rateFor]);
  const sessionChainId = useSessionChainId();
  // Stellar: the account's received notes, timed from the pool's own events.
  const stellarSession = useStellarSession();
  const stellarReceived = useMemo(
    () => (stellarOwnerShown && owner
      ? stellarReceivedNotes(stellarSession.notes as never, stellarSession.noteOrigins, owner)
      : null),
    [stellarOwnerShown, owner, stellarSession.notes, stellarSession.noteOrigins],
  );
  // A blind Stellar request is paid exactly when the SDK marked its record
  // FULFILLED (a note found through the request itself), never by an amount
  // that happens to match. The amount match still covers the address-based
  // requests made before blind links.
  const stellarRequests = stellarSession.paymentRequests;
  const rows = useMemo(() => {
    if (!loaded || loaded.owner !== ownerKey) return [];
    let paidChainId = sessionChainId;
    let paidSessionIds: Set<string>;
    if (stellarReceived) {
      const blind = new Set(stellarRequests.map((r) => stellarBlindRequestId(r.paymentId)));
      // A note that arrived through a blind request pays only that request.
      const viaRequest = new Set(stellarRequests.flatMap((r) => r.commitments.map(commitmentKey)));
      paidChainId = STELLAR_TESTNET_ID;
      paidSessionIds = new Set([
        ...paidSessionRequestIds(
          loaded.sessionRequests.filter((r) => !blind.has(r.requestId)),
          stellarReceived.filter((n) => !viaRequest.has(commitmentKey(String(n.commitment)))),
          STELLAR_TESTNET_ID,
          () => false,
        ),
        ...stellarRequests.filter((r) => r.fulfilled).map((r) => stellarBlindRequestId(r.paymentId)),
      ]);
    } else {
      paidSessionIds = paidSessionRequestIds(
        loaded.sessionRequests,
        notes as unknown as ReceivedNoteLike[],
        sessionChainId,
        (tx) => findOwnAction(tx, sessionChainId) !== null,
      );
    }
    return loaded.rows.map((r) => (
      r.status === 'OPEN' && r.chainId === paidChainId && paidSessionIds.has(r.id)
        ? { ...r, status: 'FULFILLED' as const }
        : r
    ));
  }, [loaded, ownerKey, notes, sessionChainId, stellarReceived, stellarRequests]);

  const [filter, setFilter] = useState<Filter>('all');
  const [collapsed, toggleCollapsed] = useCollapsed('payment-requests');
  // Raw page index; `page` below clamps it to the current list length.
  const [pagination, setPagination] = useState({ owner: ownerKey, filter, page: 0 });
  const samePageScope = pagination.owner === ownerKey && pagination.filter === filter;
  const pageRaw = samePageScope ? pagination.page : 0;
  if (!samePageScope) setPagination({ owner: ownerKey, filter, page: 0 });
  const setPageRaw = (page: number) => setPagination({ owner: ownerKey, filter, page });
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Measured card width drives the layout — the viewport is the wrong
  // signal: the standalone modal caps at 560px on any desktop, and
  // drawer/sheet hosts are narrower still.
  const [cardWidth, setCardWidth] = useState(0);
  const onCardLayout = useCallback((event: LayoutChangeEvent) => {
    setCardWidth(event.nativeEvent.layout.width);
  }, []);
  // onLayout lands after the first paint (RN-Web measures in a timeout after
  // its ResizeObserver), and rows can load before it. The body stays
  // transparent until measured so neither layout flashes on the wrong host.
  const measured = cardWidth > 0;
  // Narrow hosts stack the amount and actions below the request identity.
  const stacked = cardWidth < 460;

  useEffect(() => {
    let active = true;
    (async () => {
      if (!ownerKey) {
        if (active) setLoaded(null);
        return;
      }
      // A Stellar owner has no EVM request records; its requests are the rows
      // below (this tab's list, refilled from localStorage at bind).
      const stellarOwner = isStellarAccountAddress(ownerKey.toUpperCase());
      let backup = null;
      if (!stellarOwner) {
        try {
          backup = await exportAllPaymentRequests(ownerKey);
        } catch {
          backup = null;
        }
      }
      if (!active) return;
      const builtRows = stellarOwner ? [] : buildPaymentRequestRows(
        {
          backup,
          legacy: listStoredPaymentRequests(),
          linkBase: linkBase(),
          owner: ownerKey,
        },
        {
          resolveToken: getTokenMetadata,
          // STRICT for Re-issue: a token unknown on the row's chain gets no
          // prefill (a guessed fallback would request the wrong asset).
          resolveKnownToken: getKnownTokenMetadata,
          resolveChainName: (chainId) => getChainConfig(chainId)?.displayName,
        },
      );
      // Registered-v2 requests created THIS SESSION (stateless by design —
      // see services/session-payment-requests.ts): listed so a just-created
      // request is findable, without any durable per-device state. Their
      // status is OPEN here. v2 payments carry no request tag, so the `rows`
      // memo marks them paid from the notes (paidSessionRequestIds).
      const sessionRequests = listSessionPaymentRequests(ownerKey);
      const sessionRows: PaymentRequestListRow[] = sessionRequests
        .filter((record) => !builtRows.some((row) => row.chainId === record.chainId && row.id === record.requestId))
        .map((record) => {
          const token = record.chainId === STELLAR_TESTNET_ID
            ? { symbol: STELLAR_XLM.symbol, decimals: STELLAR_XLM.decimals }
            : getTokenMetadata(record.tokenAddress, record.chainId);
          let amountText = '';
          try {
            amountText = token ? formatUnits(BigInt(record.amount), token.decimals) : '';
          } catch { /* malformed hex → no amount */ }
          return {
            id: record.requestId,
            kind: 'sdk' as const,
            chainId: record.chainId,
            chainName: getChainConfig(record.chainId)?.displayName ?? `Chain ${record.chainId}`,
            createdAtMs: record.createdAtMs,
            // The figure only, like buildPaymentRequestRows: the renders add the
            // symbol (and ≈ for a share count) themselves.
            amountFormatted: amountText && token ? amountText : '—',
            assetSymbol: token?.symbol ?? '?',
            tokenAddress: record.tokenAddress,
            // A Stellar account is case-sensitive: shown and copied as is.
            recipient: stellarOwner && owner ? owner : ownerKey,
            status: 'OPEN' as PaymentRequestListRow['status'],
            payLink: record.payLink,
            reissue: token && amountText && record.chainId !== STELLAR_TESTNET_ID
              ? { chainId: record.chainId, amount: amountText, tokenAddress: record.tokenAddress as `0x${string}` }
              : null,
          };
        });
      // Bind the result to the owner that produced it.
      setLoaded({ owner: ownerKey, rows: [...sessionRows, ...builtRows], sessionRequests });
    })();
    return () => { active = false; };
  }, [ownerKey, owner, revision]);

  const counts = useMemo(() => ({
    open: rows.filter(r => r.status === 'OPEN').length,
    fulfilled: rows.filter(r => r.status === 'FULFILLED').length,
  }), [rows]);
  const filtered = useMemo(() => {
    if (filter === 'all') return rows;
    if (filter === 'open') return rows.filter(r => r.status === 'OPEN');
    return rows.filter(r => r.status === 'FULFILLED');
  }, [rows, filter]);

  // Client-side paging: the whole list is already in memory (session rows plus
  // the SDK's own records), so this is purely about not rendering a hundred
  // rows into one card. paginate() clamps the index on READ — see its own note
  // on why resetting on change is not enough.
  const { page, pageCount, start: pageStart, end: pageEnd } = paginate(
    filtered.length, REQUESTS_PER_PAGE, pageRaw,
  );
  const paged = useMemo(() => filtered.slice(pageStart, pageEnd), [filtered, pageStart, pageEnd]);

  const handleCopyLink = useCallback(async (row: PaymentRequestListRow) => {
    // Owner re-check: a stale press must never share another identity's link.
    if (!row.payLink || !ownerKey || row.recipient.toLowerCase() !== ownerKey) return;
    try {
      if (Platform.OS === 'web') {
        await navigator.clipboard.writeText(row.payLink);
      } else {
        await Share.share({ message: row.payLink, title: 'Privacy Pools Payment Request' });
      }
      const copyKey = `${row.chainId}:${row.id}`;
      setCopiedId(copyKey);
      setTimeout(() => setCopiedId((prev) => (prev === copyKey ? null : prev)), 2000);
    } catch {
      // Clipboard unavailable — nothing to surface beyond the missing flash.
    }
  }, [ownerKey]);

  const handleReissue = useCallback((row: PaymentRequestListRow) => {
    // Owner re-check mirrors handleCopyLink.
    if (!row.reissue || !ownerKey || row.recipient.toLowerCase() !== ownerKey) return;
    onNavigateAway?.();
    openRequestPaymentModal(row.reissue);
  }, [onNavigateAway, openRequestPaymentModal, ownerKey]);

  if (surface === 'page' && !owner) return null;

  // Unprompted placements hide the whole widget rather than show an empty card.
  // Gated on the OWNER-BOUND load having resolved, because `rows` is [] both
  // while loading and when genuinely empty: keying off length alone would render
  // the card during the async gap and then yank it away. So it appears only once
  // this owner affirmatively has at least one request.
  // The FILTER is deliberately ignored here — a user who filtered their requests
  // down to nothing still needs the filter UI to get back.
  if (hideWhenEmpty && (loaded?.owner !== ownerKey || rows.length === 0)) return null;

  return (
    <Card noPadding>
      <Pressable
        className={`flex-row items-center gap-[8px] p-[16px] ${collapsed ? '' : 'border-b border-b-border-light'}`}
        onPress={toggleCollapsed}
        accessibilityRole="button"
        accessibilityState={{ expanded: !collapsed }}
        testID="payment-requests-collapse"
      >
        <Text className="flex-1 font-pp-sans-semi-bold text-[15px] text-text">
          Payment Requests{owner && rows.length > 0 ? ` (${rows.length})` : ''}
        </Text>
        {/* nw-keep(data-color): vector icon uses the active theme palette. */}
        <Ionicons name={collapsed ? 'chevron-down' : 'chevron-up'} size={22} color={colors.textSecondary} />
      </Pressable>
      {!collapsed && !owner ? (
        <Text className="p-[16px] font-pp-sans text-[12px] text-text-secondary">
          Connect your wallet to see Payment Requests you have created.
        </Text>
      ) : null}
      {owner && !collapsed ? (
        <View className="px-[16px] pb-[16px] pt-[12px]">
          <View onLayout={onCardLayout} className={`w-full gap-[12px] ${measured ? '' : 'opacity-0'}`}>
            <View className="flex-row flex-wrap items-center justify-between gap-x-[24px] gap-y-[8px]">
              <View className="flex-row flex-wrap items-center gap-[16px]">
                {(['all', 'open', 'fulfilled'] as Filter[]).map((f) => {
                  const active = f === filter;
                  return (
                    <Pressable
                      key={f}
                      onPress={() => setFilter(f)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      className="py-[6px]"
                    >
                      <Text className={`text-[12px] ${active ? 'font-pp-sans-semi-bold text-text underline' : 'font-pp-sans text-text-secondary'}`}>
                        {f === 'all' ? 'All' : f === 'open' ? `Open (${counts.open})` : `Fulfilled (${counts.fulfilled})`}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <View className="flex-row items-center gap-[16px]">
                <Pressable accessibilityRole="button" onPress={openExportPaymentRequestsModal} className="py-[6px]">
                  <Text className="font-pp-regular text-[14px] text-text-muted underline">Export</Text>
                </Pressable>
                <Pressable accessibilityRole="button" onPress={openImportPaymentRequestsModal} className="py-[6px]">
                  <Text className="font-pp-regular text-[14px] text-text-muted underline">Import</Text>
                </Pressable>
              </View>
            </View>

            {filtered.length === 0 ? (
              <View className="items-center px-[16px] py-[28px]">
                <Text className="font-pp-sans text-[12px] text-center text-text-secondary">
                  {rows.length === 0
                    ? 'No payment requests on this device. Create a request or import a saved link or backup.'
                    : 'Nothing matches this filter.'}
                </Text>
              </View>
            ) : (
              <View className="gap-0">
                {paged.map((r, idx) => {
                  const isLast = idx === paged.length - 1;
                  // ARCHIVED is a real v2.0 status, not an unrecognised one: without
                  // its own arm it fell through to the LEGACY label, which says
                  // something different and untrue about the record.
                  const pill: { tone: PillTone; label: string } = r.status === 'OPEN'
                    ? { tone: 'warning', label: 'Open' }
                    : r.status === 'FULFILLED'
                      ? { tone: 'success', label: 'Fulfilled' }
                      : r.status === 'ARCHIVED'
                        ? { tone: 'neutral', label: 'Archived' }
                        : { tone: 'neutral', label: 'Legacy' };
                  const action = r.payLink ? (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => handleCopyLink(r)}
                      className="min-h-[32px] min-w-[80px] items-center justify-center rounded-control border border-border-light px-[10px] py-[6px]"
                    >
                      <Text className="font-pp-sans-medium text-[11px] text-text">
                        {copiedId === `${r.chainId}:${r.id}` ? 'Copied' : 'Copy link'}
                      </Text>
                    </Pressable>
                  ) : r.reissue ? (
                    // Link not rebuildable (legacy V1 / no stored slots):
                    // re-issue opens the create flow prefilled with the
                    // original chain/amount/token.
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => handleReissue(r)}
                      className="min-h-[32px] min-w-[80px] items-center justify-center rounded-control border border-border-light px-[10px] py-[6px]"
                    >
                      <Text className="font-pp-sans-medium text-[11px] text-text">
                        Re-issue
                      </Text>
                    </Pressable>
                  ) : null;

                  return (
                    <View
                      key={`${r.kind}-${r.chainId}-${r.id}`}
                      className={`${stacked ? 'gap-[12px]' : 'flex-row items-center gap-[16px]'} py-[16px] ${!isLast ? 'border-b border-border-light' : ''}`}
                    >
                      <View className="min-w-0 flex-1 flex-row items-center gap-[10px]">
                        {/* The chain rides the icon's badge, as on Activity rows; the
                            testnet pill is what tells Sepolia from Ethereum. */}
                        <View accessible accessibilityRole="image" accessibilityLabel={`${r.assetSymbol} on ${r.chainName}`}>
                          <TokenNetworkIcon symbol={r.assetSymbol} chainId={r.chainId} size={28} badgeSize={14} />
                        </View>
                        <View className="min-w-0 flex-1 gap-[3px]">
                          <View className="flex-row flex-wrap items-center gap-[8px]">
                            <Text className="font-pp-sans-semi-bold text-[14px] text-text">Payment request</Text>
                            <Pill tone={pill.tone} label={pill.label} />
                          </View>
                          {/* Date and time, as on Activity rows: "Oct 6 · 00:16". */}
                          <Text className="font-pp-sans text-[12px] text-text-muted">
                            {[formatShortDate(r.createdAtMs), formatShortTime(r.createdAtMs)].filter(Boolean).join(' \u00B7 ')}
                          </Text>
                        </View>
                      </View>
                      <View className={`min-w-0 flex-row items-center gap-[16px] ${stacked ? 'pl-[38px]' : 'flex-1 justify-end'}`}>
                        <View className={`min-w-0 gap-[3px] ${stacked ? 'flex-1' : 'shrink items-end'}`}>
                          <Text className={`font-pp-sans-semi-bold text-[13.5px] text-text ${stacked ? '' : 'text-right'}`}>
                            {balanceDisplay(r.amountFormatted, r.assetSymbol, r.chainId, r.tokenAddress).text}
                          </Text>
                          <ShareCountHint hint={balanceDisplay(r.amountFormatted, r.assetSymbol, r.chainId, r.tokenAddress).hint} />
                          {/* The dollar value, as on Activity rows; the chain is on the icon's badge. */}
                          <Text className={`font-pp-sans text-[11.5px] text-text-muted ${stacked ? '' : 'text-right'}`}>{usdLabel(r)}</Text>
                        </View>
                        {action}
                      </View>
                    </View>
                  );
                })}
              </View>
            )}

            {pageCount > 1 ? (
              <View className={`${stacked ? 'flex-col gap-[8px]' : 'flex-row items-center justify-between'} w-full`}>
                {/* The RANGE, not a bare count: the header above states the whole
                    set ("15 open"), so this line has to say which slice of it is
                    on screen or the two figures read as contradicting each other. */}
                <Text className="font-pp-sans text-[11px] text-text-secondary">
                  {`${pageStart + 1}\u2013${pageStart + paged.length} of ${filtered.length}`}
                </Text>
                <View className="flex-row items-center gap-[8px]">
                  <Pressable
                    onPress={() => setPageRaw(Math.max(0, page - 1))}
                    disabled={page === 0}
                    accessibilityLabel="Previous page of payment requests"
                    testID="payment-requests-prev"
                    className={`rounded-control border border-border-light px-[10px] py-[4px] ${page === 0 ? 'opacity-40' : ''}`}
                  >
                    <Text className="font-pp-sans-medium text-[11px] text-text">Previous</Text>
                  </Pressable>
                  <Text className="font-pp-sans text-[11px] text-text-secondary">
                    {`Page ${page + 1} of ${pageCount}`}
                  </Text>
                  <Pressable
                    onPress={() => setPageRaw(Math.min(pageCount - 1, page + 1))}
                    disabled={page >= pageCount - 1}
                    accessibilityLabel="Next page of payment requests"
                    testID="payment-requests-next"
                    className={`rounded-control border border-border-light px-[10px] py-[4px] ${page >= pageCount - 1 ? 'opacity-40' : ''}`}
                  >
                    <Text className="font-pp-sans-medium text-[11px] text-text">Next</Text>
                  </Pressable>
                </View>
              </View>
            ) : null}

            <View className="border-t border-border-light pt-[12px]">
              <Text className="font-pp-sans text-[11px] leading-[17px] text-text-secondary">
                Payment requests don&apos;t sync across devices. Use export to back up saved requests and import to restore them.
              </Text>
            </View>
          </View>
        </View>
      ) : null}
    </Card>
  );
}
