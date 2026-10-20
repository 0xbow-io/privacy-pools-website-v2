import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Platform, Pressable, ScrollView, useWindowDimensions, Text, TextInput, View } from 'react-native';
import { Modal } from '@/components/ui/modal';
import Ionicons from '@expo/vector-icons/Ionicons';
import QRCode from 'react-native-qrcode-svg';
import { useAccount } from 'wagmi';

import { useTheme } from '@/components/theme-provider';
import { getChainConfig, supportedChainIds } from '@/config/chains';
import { loadStoredAccountExport } from '@/components/sdk-provider';
import type { Note } from '@/services/sdk-types';
import { mergeNotesByCommitment } from '@/services/note-sets';
import { Colors } from '@/constants/theme';
import { joinChainNames } from '@/services/receive-setup';

import { DROPDOWN_SHADOW, modalCardShadow } from '@/components/ui/web-style-shims';
import { usePools, type Transaction } from '@/components/pools-provider';
import { useNotes } from '@/hooks/use-notes';
import { useLiveNotesChainId } from '@/hooks/use-live-notes-chain-id';
import { usePoolSession } from '@/hooks/use-pool-session';
import { findSentAudits } from '@/services/audit-store';
import { buildSentTxHashSet, findSentTransfer } from '@/services/sent-transfers-store';
import { buildWithdrawFeeTxHashSet } from '@/services/withdraw-fees-store';
import { isInternalSpendRow, mergeMyTransactions } from '@/services/transfer-direction';
import { findWithdrawFee } from '@/services/withdraw-fees-store';
import {
  encodePartialViewingKeyBatch,
  buildVerifyUrl,
  type PartialViewingKeyV1,
} from '@/services/audit-receipt';
import {
  TYPE_LABEL,
  EXPORT_TYPES,
  buildAccountingItems,
  isAccountingTxMine,
  type OwnershipEvidence,
  buildKoinlyCsv,
  parseDay,
  type AcctItem,
  type AcctType,
} from '@/services/accounting-export';
import { useShareRateBook } from '@/hooks/use-share-rates';
import { shareRateKey } from '@/services/share-rates';
import { shareConversionAt } from '@/services/share-rate-history';

// Withdrawals and Exits are public on-chain (no private viewing key) —
// they're CSV-only (csvOnly). Types and the CSV builder live in
// services/accounting-export.

type TypeChip = { label: string; icon: keyof typeof Ionicons.glyphMap; counterparty: 'recipient' | null; csvOnly?: boolean };
// Keyed by every AcctType, so a new type cannot be built and then left out of
// the selection that gates the export.
const TYPE_CHIPS: Record<AcctType, TypeChip> = {
  deposit: { label: 'Deposits', icon: 'arrow-down-outline', counterparty: null },
  'transfer-out': { label: 'Transfers out', icon: 'paper-plane-outline', counterparty: 'recipient' },
  'transfer-in': { label: 'Transfers in', icon: 'enter-outline', counterparty: null },
  trade: { label: 'Swaps', icon: 'swap-vertical-outline', counterparty: null },
  withdraw: { label: 'Withdrawals', icon: 'arrow-up-outline', counterparty: 'recipient', csvOnly: true },
  fee: { label: 'Fees', icon: 'receipt-outline', counterparty: null, csvOnly: true },
  exit: { label: 'Exits', icon: 'exit-outline', counterparty: 'recipient', csvOnly: true },
};
const TYPES: ({ key: AcctType } & TypeChip)[] = EXPORT_TYPES.map((key) => ({ key, ...TYPE_CHIPS[key] }));


// A QR much over ~1.2KB gets too dense to scan reliably on a phone.
const QR_MAX = 1200;

type AccountingContextType = {
  /** `section: 'viewing-key'` opens with the viewing-key overview expanded. */
  openAccounting: () => void;
  closeAccounting: () => void;
};
const AccountingContext = createContext<AccountingContextType>({ openAccounting: () => {}, closeAccounting: () => {} });
export function useAccounting() { return useContext(AccountingContext); }

export function AccountingModalProvider({ children }: { children: React.ReactNode }) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { width: windowWidth } = useWindowDimensions();
  const isMobileSheet = windowWidth <= 540;
  const { data } = usePools();
  const { notes } = useNotes();
  const book = useShareRateBook();
  const { address } = useAccount();
  // Identity mode gates payer-address ownership: with an imported account key
  // the connected wallet is only the payer, never the ledger's identity.
  const { identityMode, sessionAddress } = usePoolSession();
  const [isOpen, setIsOpen] = useState(false);
  // Multi-select: defaults to ALL types, deselectable.
  const [selectedTypes, setSelectedTypes] = useState<Set<AcctType>>(() => new Set(TYPES.map((t) => t.key)));
  const [showFilters, setShowFilters] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [party, setParty] = useState('');
  const [recipientFocused, setRecipientFocused] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [exported, setExported] = useState<string | null>(null); // batch verify URL
  const [copied, setCopied] = useState<'link' | 'keys' | null>(null);
  const [exporting, setExporting] = useState(false);

  const toggleType = useCallback((k: AcctType) => {
    setSelectedTypes((prev) => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k); else n.add(k);
      return n;
    });
  }, []);

  const openAccounting = useCallback(() => {
    setExported(null);
    setCopied(null);
    setIsOpen(true);
  }, []);

  const closeAccounting = useCallback(() => setIsOpen(false), []);

  // The account's OWN transactions, gated by EXACT ownership evidence
  // (isAccountingTxMine): owned-note creation txs, stamped sends, recorded
  // withdrawals, commitment-proven exits, and — in wallet identity mode only —
  // the depositing address. A shared LABEL is deliberately not evidence
  // (labels survive transfers across parties: Bob's exit of a note Alice sent
  // him must not enter Alice's ledger). No fall-back-to-all: an export must
  // never widen to other people's transactions the way the empty "My
  // Transactions" table once fell back to the global feed for display.
  const mineRows = useMemo(() => {
    const noteTxHashes = new Set<string>();
    for (const n of notes) {
      if (n.txHash) noteTxHashes.add(String(n.txHash).toLowerCase());
    }
    const evidence: OwnershipEvidence = {
      noteTxHashes,
      sentTxHashes: buildSentTxHashSet(),
      withdrawTxHashes: buildWithdrawFeeTxHashSet(),
      // Exits proven identity-scoped in pools-provider (ragequitter address in
      // wallet mode, exact exited commitment otherwise).
      exitTxHashes: new Set(data.myExits.map((r) => String(r.txHash || '').toLowerCase())),
      // Payer-address equality is ownership ONLY in wallet identity mode; with
      // an imported account key the wallet is just the payer.
      walletAddressLc: identityMode === 'wallet' ? (address?.toLowerCase() ?? null) : null,
    };
    // Internal spends (self merge/split) get no lineage row, so nothing
    // replaces their ASP row — suppress them before classification or a
    // later-spent internal output would export as income.
    const mineEvents = data.transactions.filter(
      (tx) => isAccountingTxMine(tx, evidence)
        && !isInternalSpendRow(tx, data.internalTxHashes),
    );
    return mergeMyTransactions(mineEvents, data.lineageRows, data.anchorTxHashes);
  }, [data.transactions, data.lineageRows, data.anchorTxHashes, data.internalTxHashes, data.myExits, notes, address, identityMode]);

  // Owned notes on every chain: a swap's output note lives on its own chain.
  // Read from this device's stored exports, as the balances do; no request.
  const liveChainId = useLiveNotesChainId();
  const notesByChain = useMemo(() => {
    const map = new Map<number, Note[]>();
    const identity = sessionAddress ?? address;
    if (identity) {
      for (const cid of supportedChainIds) {
        if (getChainConfig(cid)?.chainType !== 'evm') continue;
        const stored = (loadStoredAccountExport(identity, cid)?.notes ?? []) as unknown as Note[];
        if (stored.length > 0) map.set(cid, stored);
      }
    }
    // The live session's notes are the freshest copy of their chain's.
    if (liveChainId !== null) map.set(liveChainId, mergeNotesByCommitment(notes as unknown as Note[], [map.get(liveChainId) ?? []]));
    return map;
  }, [notes, sessionAddress, address, liveChainId]);

  // All exportable accounting items: the mine-scoped feed mapped per-type
  // (viewing keys where provable), augmented with full-history snapshot
  // deposits/exits and batch-collapsed — see buildAccountingItems.
  const allItems = useMemo<AcctItem[]>(() => buildAccountingItems({
    mineRows,
    notes: notes as never[],
    notesByChain,
    sentTxHashes: buildSentTxHashSet(),
    transferTxHashes: data.transferTxHashes,
    transferClassificationReady: data.transferClassificationReady,
    myDeposits: data.myDeposits,
    myExits: data.myExits,
    evmChainId: data.defaultChainId,
    findSentAudits,
    findSentTransfer,
  }), [mineRows, notes, notesByChain, data.transferTxHashes, data.transferClassificationReady, data.myDeposits, data.myExits, data.defaultChainId]);

  const fromTs = parseDay(from, false);
  const toTs = parseDay(to, true);
  const partyLc = party.trim().toLowerCase();

  const matches = useMemo(() => allItems.filter((it) => {
    if (!selectedTypes.has(it.type)) return false;
    if (fromTs != null && it.timestamp < fromTs) return false;
    if (toTs != null && it.timestamp > toTs) return false;
    if (partyLc) {
      if (!it.counterparty || !it.counterparty.toLowerCase().includes(partyLc)) return false;
    }
    return true;
  }), [allItems, selectedTypes, fromTs, toTs, partyLc]);

  // Distinct counterparty addresses across the SELECTED types — for the
  // recipient-field autocomplete.
  const recipientOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const it of allItems) {
      if (selectedTypes.has(it.type) && it.counterparty) {
        const k = it.counterparty.toLowerCase();
        if (!seen.has(k)) seen.set(k, it.counterparty);
      }
    }
    return Array.from(seen.values());
  }, [allItems, selectedTypes]);

  const recipientMatches = useMemo(() => {
    const q = party.trim().toLowerCase();
    return recipientOptions
      .filter((a) => (!q || a.toLowerCase().includes(q)) && a.toLowerCase() !== q)
      .slice(0, 6);
  }, [recipientOptions, party]);

  const countByType = useMemo(() => {
    const c: Record<AcctType, number> = { deposit: 0, 'transfer-in': 0, 'transfer-out': 0, withdraw: 0, fee: 0, exit: 0, trade: 0 };
    for (const it of allItems) c[it.type] += 1;
    return c;
  }, [allItems]);

  // Viewing-key export only applies to items that HAVE a private note bundle
  // (deposits + transfers); withdrawals/exits are public and CSV-only.
  const keyItems = useMemo(() => matches.filter((m) => m.bundles != null && m.bundles.length > 0), [matches]);

  // A chain whose history has not loaded hides its deposits and spends, and
  // its notes would export as income. Nothing leaves the modal until it has.
  const pendingChainIds = data.historyPendingChainIds;
  const historyReady = pendingChainIds.length === 0;
  const syncingCopy = historyReady
    ? null
    : `Syncing ${joinChainNames(pendingChainIds.map((cid) => getChainConfig(cid)?.displayName || `chain ${cid}`))} history…`;
  const historyReadyRef = useRef(historyReady);
  useEffect(() => { historyReadyRef.current = historyReady; }, [historyReady]);

  const doExport = useCallback(() => {
    if (!keyItems.length || !historyReadyRef.current) return;
    // One key per NOTE, not per item — a multi-lineage transfer carries
    // several bundles, and each must verify against its own commitment.
    const bundles = keyItems.flatMap((it) => (it.bundles as PartialViewingKeyV1[]).map((b) => ({
      ...b,
      memo: b.memo ?? `${TYPE_LABEL[it.type]}${it.timestamp ? ` · ${new Date(it.timestamp).toISOString().slice(0, 10)}` : ''}`,
    })));
    setExported(buildVerifyUrl(encodePartialViewingKeyBatch(bundles)));
  }, [keyItems]);

  const copy = useCallback(async (text: string, which: 'link' | 'keys') => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    } catch { /* noop */ }
  }, []);

  const download = useCallback(() => {
    if (!keyItems.length || typeof document === 'undefined') return;
    const payload = JSON.stringify({ kind: 'ppv2-accounting-export', count: keyItems.length, verifyUrl: exported, items: keyItems.flatMap((m) => m.bundles ?? []) }, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `accounting-keys-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [keyItems, exported]);

  // The Koinly CSV adapts to the SAME filters as the viewing-key export
  // (type + date + recipient) so the count matches what's selected; just
  // sorted oldest-first for a clean ledger.
  const koinlyItems = useMemo(
    () => [...matches].sort((a, b) => a.timestamp - b.timestamp),
    [matches],
  );

  const downloadKoinly = useCallback(async () => {
    // Exactly the set the button counts, even if the data moves mid-build.
    const items = koinlyItems;
    if (typeof document === 'undefined' || !items.length || !historyReadyRef.current) return;
    setExporting(true);
    try {
      // Row mapping lives in services/accounting-export (pure, golden-file
      // tested); the modal wires the device-backed fee store, notes and share rates.
      const csv = await buildKoinlyCsv(items, {
        notes,
        findFee: findWithdrawFee,
        shareConversion: (it) => {
          const series = book?.get(shareRateKey(it.chainId, it.tokenId));
          return series ? shareConversionAt(series, { timestampSec: it.timestamp / 1000 }) : null;
        },
      });
      if (!historyReadyRef.current) return;
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `koinly-privacy-pools-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }, [koinlyItems, notes, book]);

  const value = useMemo(() => ({ openAccounting, closeAccounting }), [openAccounting, closeAccounting]);
  const qrTooBig = !!exported && exported.length > QR_MAX;

  return (
    <AccountingContext.Provider value={value}>
      {children}
      <Modal animationType={isMobileSheet ? 'slide' : 'fade'} transparent visible={isOpen} onRequestClose={closeAccounting}>
        {/* justify/padding branches are mutually exclusive: co-active base+sheet classes
            resolve by CSS file order on web (center/20px win). Old style array was later-wins (end/0). */}
        <View className={`flex-1 items-center bg-[rgba(0,0,0,0.5)] ${isMobileSheet ? 'justify-end p-0' : 'justify-center p-[20px]'}`}>
          <View className={`w-full max-w-[720px] gap-[14px] border border-border bg-card-background p-[24px] ${isMobileSheet ? 'max-w-full max-h-[94%] rounded-t-card rounded-b-none border-b-0 pt-[26px]' : 'rounded-card'}`}
            // nw-keep(platform-css): modal-card drop shadow (shared, scheme-tinted), as on the other modals
            style={modalCardShadow(colorScheme)}
          >
            {/* nw-keep(data-color): sheet grabber fill is a runtime theme token (no class value) */}
            {isMobileSheet && <View className="absolute top-[10px] z-[10] h-[4px] w-[44px] self-center rounded-[2px]" style={{ backgroundColor: colors.border }} />}
            <View className="flex-row items-start justify-between gap-[12px]">
              <View className="flex-1 gap-[4px]">
                <Text className="font-pp-medium text-[11px] tracking-[2px] text-text-muted">ACCOUNTING</Text>
                <Text className="font-pp-bold text-[20px] leading-[25px] text-text">
                  {exported ? 'Share with your accountant' : 'Export for accounting'}
                </Text>
              </View>
              <Pressable className="h-[36px] w-[36px] items-center justify-center rounded-control border border-border-light" onPress={closeAccounting}>
                {/* nw-keep(data-color): close glyph color is the text theme token into the vector-icon sink */}
                <Ionicons name="close" size={18} color={colors.text} />
              </Pressable>
            </View>

            {!exported ? (
              <ScrollView className="max-h-[540px]" contentContainerClassName="gap-[14px]">
                <Text className="font-pp-regular text-[13px] leading-[19px] text-text-secondary">
                  Pick what to include, then share a verifiable proof link (with a QR for small sets) or export
                  a CSV. Without exposing your master key or any other activity.
                </Text>

                {/* Multi-select — defaults to all, tap to toggle */}
                <View className="flex-row flex-wrap gap-[8px]">
                  {TYPES.map((t) => {
                    const selected = selectedTypes.has(t.key);
                    return (
                      <Pressable
                        key={t.key}
                        onPress={() => toggleType(t.key)}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: selected }}
                        testID={`accounting-type-${t.key}`}
                        // Selected fill/border are class-authored ternaries; a style FUNCTION
                        // isn't used so css-interop's web runtime keeps the conditional styling.
                        className={`grow flex-row items-center justify-center gap-[7px] rounded-control border py-[9px] px-[13px] ${selected ? 'border-button-primary bg-button-primary' : 'border-dashed border-border-light bg-transparent opacity-60'}`}
                      >
                        {/* nw-keep(data-color): pill icon color is a runtime theme token (selected/unselected) into the vector-icon sink */}
                        {/* Both states read as a checkbox. The excluded pill used to show the type's own
                            icon at full contrast and looked like the active choice (QA 2026-09-24). */}
                        <Ionicons name={selected ? 'checkmark-circle' : 'ellipse-outline'} size={15} color={selected ? colors.buttonPrimaryText : colors.textSecondary} />
                        <Text className={`font-pp-medium text-[13px] ${selected ? 'text-button-primary-text' : 'text-text-muted line-through'}`}>{t.label}</Text>
                        <Text className={`ml-[2px] font-pp-semi-bold text-[12px] ${selected ? 'text-button-primary-text' : 'text-text-muted'}`}>{countByType[t.key]}</Text>
                      </Pressable>
                    );
                  })}
                </View>

                {/* Filters — tucked away to keep the modal clean */}
                <Pressable className="flex-row items-center gap-[6px] py-[4px]" onPress={() => setShowFilters((v) => !v)}>
                  {/* nw-keep(data-color): toggle icon color is a runtime theme token into the vector-icon sink */}
                  <Ionicons name="options-outline" size={14} color={colors.textSecondary} />
                  <Text className="flex-1 font-pp-medium text-[12px] text-text-secondary">
                    Filters{(from || to || party) ? ' · active' : ''}
                  </Text>
                  {/* nw-keep(data-color): chevron color is a runtime theme token into the vector-icon sink */}
                  <Ionicons name={showFilters ? 'chevron-up' : 'chevron-down'} size={14} color={colors.textMuted} />
                </Pressable>
                {showFilters ? (
                  <View className="flex-row gap-[10px] z-[10]">
                    <View className="flex-1 gap-[5px]">
                      <Text className="font-pp-medium text-[11px] tracking-[0.3px] text-text-muted">From</Text>
                      {/* nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path) */}
                      <TextInput value={from} onChangeText={setFrom} placeholder="YYYY-MM-DD" placeholderTextColor={colors.textMuted}
                        autoCapitalize="none" className="rounded-control border border-border-light px-[16px] py-[13px] font-pp-regular text-[13px] text-text" />
                    </View>
                    <View className="flex-1 gap-[5px]">
                      <Text className="font-pp-medium text-[11px] tracking-[0.3px] text-text-muted">To</Text>
                      {/* nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path) */}
                      <TextInput value={to} onChangeText={setTo} placeholder="YYYY-MM-DD" placeholderTextColor={colors.textMuted}
                        autoCapitalize="none" className="rounded-control border border-border-light px-[16px] py-[13px] font-pp-regular text-[13px] text-text" />
                    </View>
                    <View className="flex-[1.8] gap-[5px] z-[10]">
                      <Text className="font-pp-medium text-[11px] tracking-[0.3px] text-text-muted">Counterparty (optional)</Text>
                      <View className="relative z-[10]">
                        {/* nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path) */}
                        <TextInput
                          value={party}
                          onChangeText={setParty}
                          onFocus={() => { if (blurTimer.current) clearTimeout(blurTimer.current); setRecipientFocused(true); }}
                          onBlur={() => { blurTimer.current = setTimeout(() => setRecipientFocused(false), 150); }}
                          placeholder="0x… or part of an address"
                          placeholderTextColor={colors.textMuted}
                          autoCapitalize="none"
                          autoCorrect={false}
                          className="rounded-control border border-border-light px-[16px] py-[13px] font-pp-regular text-[13px] text-text"
                        />
                        {recipientFocused && recipientMatches.length > 0 ? (
                          <View
                            className="absolute left-0 right-0 top-[100%] z-[50] mt-[4px] rounded-card border border-border-light bg-menu-background p-[6px]"
                            // nw-keep(platform-css): the shared dropdown shadow (web box-shadow, native elevation)
                            style={DROPDOWN_SHADOW}
                            {...(Platform.OS === 'web' ? { onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault() } : null)}
                          >
                            {recipientMatches.map((addr) => (
                              <Pressable
                                key={addr}
                                className="flex-row items-center gap-[8px] rounded-pill px-[12px] py-[9px] hover:bg-background-secondary"
                                {...(Platform.OS === 'web' ? ({ tabIndex: -1 } as object) : null)}
                                onPress={() => { if (blurTimer.current) clearTimeout(blurTimer.current); setParty(addr); setRecipientFocused(false); }}
                              >
                                {/* nw-keep(data-color): suggestion icon color is a runtime theme token into the vector-icon sink */}
                                <Ionicons name="person-circle-outline" size={15} color={colors.textMuted} />
                                <Text className="font-pp-regular text-[12px] text-text" numberOfLines={1}>
                                  {`${addr.slice(0, 10)}…${addr.slice(-8)}`}
                                </Text>
                              </Pressable>
                            ))}
                          </View>
                        ) : null}
                      </View>
                    </View>
                  </View>
                ) : null}

                {/* Share proof — viewing keys (deposits/transfers). Withdrawals
                    & exits are public, so they have no key to share here. */}
                {syncingCopy ? (
                  <View testID="accounting-history-syncing" className="flex-row items-center justify-center gap-[8px] rounded-inner bg-background-secondary p-[12px]">
                    {/* nw-keep(data-color): sync glyph color is a runtime theme token into the vector-icon sink */}
                    <Ionicons name="sync-outline" size={14} color={colors.textSecondary} />
                    <Text className="font-pp-regular text-[12px] leading-[17px] text-text-secondary">{syncingCopy}</Text>
                  </View>
                ) : null}
                {keyItems.length ? (
                  <Pressable
                    // opacity gate is a class-authored ternary so css-interop keeps it on web
                    className={`mt-[2px] items-center justify-center rounded-control bg-button-primary py-[13px] ${historyReady ? 'opacity-100' : 'opacity-50'}`}
                    onPress={doExport}
                    disabled={!historyReady}
                  >
                    <Text className="font-pp-semi-bold text-[14px] text-button-primary-text">
                      {`Share proof · ${keyItems.length} ${keyItems.length === 1 ? 'key' : 'keys'}`}
                    </Text>
                  </Pressable>
                ) : (
                  <View className="rounded-inner bg-background-secondary p-[12px]">
                    <Text className="text-center font-pp-regular text-[12px] leading-[17px] text-text-secondary">
                      {selectedTypes.size === 0
                        ? 'Select at least one type above.'
                        : matches.length
                          ? 'The selected types are public on-chain (no viewing key to share). Use the CSV below.'
                          : 'No matching transactions.'}
                    </Text>
                  </View>
                )}

                {/* Tax export — all transaction types in the date range, as a
                    Koinly CSV (separate from the per-type viewing-key export). */}
                {Platform.OS === 'web' && (
                  <Pressable
                    // opacity gate is a class-authored ternary so css-interop keeps it on web
                    className={`flex-row items-center justify-center gap-[8px] rounded-control border border-border-light py-[11px] ${(koinlyItems.length && !exporting && historyReady) ? 'opacity-100' : 'opacity-50'}`}
                    onPress={() => { void downloadKoinly(); }}
                    disabled={!koinlyItems.length || exporting || !historyReady}
                  >
                    {/* nw-keep(data-color): icon color is a runtime theme token into the vector-icon sink */}
                    <Ionicons name="document-text-outline" size={14} color={colors.text} />
                    <Text className="font-pp-medium text-[13px] text-text">
                      {exporting
                        ? 'Building CSV…'
                        : koinlyItems.length
                          ? `Export to CSV (Koinly compatible) · ${koinlyItems.length} tx`
                          : 'Export to CSV (Koinly compatible)'}
                    </Text>
                  </Pressable>
                )}
                {Platform.OS === 'web' ? (
                  <Text className="-mt-[2px] text-center font-pp-regular text-[11px] leading-[15px] text-text-muted">
                    Convenience export from your synced history (current filters). Transfer and claim fees are
                    itemized from on-chain data. Withdrawal fees are itemized only for withdrawals sent from this
                    device; others show the gross on-chain amount. Review before filing.
                  </Text>
                ) : null}

                {/* The account viewing key has its own modal (Privacy & keys):
                    its permanent, read-everything warning next to this scoped
                    export read as a contradiction. One pointer, no key here. */}
                <View className="mt-[2px] h-[1px] bg-border-light" />
                <Text className="font-pp-regular text-[11px] leading-[16px] text-text-muted">
                  Your account viewing key is under Privacy &amp; keys in the account menu.
                </Text>
              </ScrollView>
            ) : (
              <ScrollView className="max-h-[540px]" contentContainerClassName="items-center gap-[14px]">
                <Text className="text-center font-pp-regular text-[13px] leading-[19px] text-text-secondary">
                  {keyItems.length} {keyItems.length === 1 ? 'key' : 'keys'} bundled. Your accountant opens the link
                  (or pastes it at /audit) to verify every one on-chain. No wallet needed.
                </Text>

                {qrTooBig ? (
                  <View className="rounded-inner bg-background-secondary p-[12px]">
                    <Text className="text-center font-pp-regular text-[12px] leading-[17px] text-text-secondary">
                      Too many transactions for a single QR. Use the link or the download instead.
                    </Text>
                  </View>
                ) : (
                  <View className="rounded-inner bg-[#FFFFFF] p-[12px]">
                    {/* nw-keep(svg-or-canvas): fixed QR module/background colors (theme-independent for scannability; QRCode color props) */}
                    <QRCode value={exported} size={172} backgroundColor="#FFFFFF" color="#000000" />
                  </View>
                )}

                <Pressable className="w-full flex-row items-center gap-[10px] rounded-control border border-border-light px-[12px] py-[10px]" onPress={() => copy(exported, 'link')}>
                  <Text className="flex-1 font-pp-regular text-[11px] leading-[15px] text-text-secondary" numberOfLines={2}>{exported}</Text>
                  {/* nw-keep(data-color): copy icon color is a runtime theme token into the vector-icon sink */}
                  <Ionicons name={copied === 'link' ? 'checkmark' : 'copy-outline'} size={16} color={colors.textSecondary} />
                </Pressable>

                <View className="flex-row flex-wrap justify-center gap-[8px]">
                  <Pressable className="items-center justify-center rounded-control border border-border-light px-[16px] py-[10px]" onPress={() => copy(exported, 'link')}>
                    <Text className="font-pp-medium text-[13px] text-text">{copied === 'link' ? 'Copied' : 'Copy link'}</Text>
                  </Pressable>
                  {typeof document !== 'undefined' && (
                    <Pressable className="items-center justify-center rounded-control border border-border-light px-[16px] py-[10px]" onPress={download}>
                      <Text className="font-pp-medium text-[13px] text-text">Download</Text>
                    </Pressable>
                  )}
                  <Pressable className="items-center justify-center rounded-control border border-border-light px-[16px] py-[10px]" onPress={() => Linking.openURL(exported)}>
                    <Text className="font-pp-medium text-[13px] text-text">Open</Text>
                  </Pressable>
                </View>

                <Pressable onPress={() => setExported(null)}>
                  <Text className="py-[4px] font-pp-medium text-[13px] text-accent">‹ Change filters</Text>
                </Pressable>
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
    </AccountingContext.Provider>
  );
}
