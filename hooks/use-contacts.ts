import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useSdkContext } from '@/components/sdk-provider';
import { addNewContact, canonicalAddress, setContactName, type AddressFormat, type Contact, type RecipientRecord } from '@/services/address-book-core';
import { getContactsVersion, readContacts, readRecipientRecords, subscribeContacts, writeContacts } from '@/services/address-book-store';
import { buildRecipientIndex, payoutRecordsFromActivity, rankRecipientSuggestions, withRecords, yieldToHost, type PayoutRecord, type RecipientIndex, type RecipientSuggestion } from '@/services/recipient-suggestions';
import { usePools } from '@/components/pools-provider';
import { useMyTransactionOwnership } from '@/hooks/use-my-transaction-ownership';
import { mergeMyTransactions } from '@/services/transfer-direction';
import { getWithdrawalProcessorAddress } from '@/config/relayer';
import { getSwapProcessorAddress } from '@/config/intent-swaps';
import { getPinnedYieldRouters } from '@/config/yield';
import { readAllWithdrawRecipients } from '@/services/withdraw-recipients-store';
import { readAllSentTransfers } from '@/services/sent-transfers-store';

/**
 * The signed-in owner's saved contacts. Keyed on the session identity (the
 * same one the account export uses), never the connected wallet.
 */
export function useContacts(): {
  owner: string | null;
  contacts: Contact[];
  setName: (address: string, name: string) => string | null;
  replaceAll: (list: readonly Contact[]) => boolean;
  /** Addresses this account paid (owner bucket + the device bucket), newest first. */
  recipients: RecipientRecord[];
  /** Add a new address with a name, or report why not (invalid, already saved, list full). */
  addContact: (address: string, name: string) => string | null;
} {
  const { sessionAddress } = useSdkContext();
  const owner = sessionAddress ?? null;
  // The version is an explicit input: a read the compiler cannot see change
  // must not be memoized on `owner` alone.
  const version = useSyncExternalStore(subscribeContacts, getContactsVersion, getContactsVersion);
  const contacts = useMemo(() => { void version; return readContacts(owner); }, [owner, version]);
  const recipients = useMemo(() => {
    void version;
    const merged = new Map<string, RecipientRecord>();
    // Device bucket first, owner bucket second: the owner's entry wins a tie.
    for (const r of [...readRecipientRecords(null), ...(owner ? readRecipientRecords(owner) : [])]) {
      const key = canonicalAddress(r.address)?.key;
      if (!key) continue;
      const prev = merged.get(key);
      if (!prev || r.lastUsedAt >= prev.lastUsedAt) merged.set(key, r);
    }
    return Array.from(merged.values()).reverse().sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }, [owner, version]);
  const setName = useCallback((address: string, name: string): string | null => {
    if (!owner) return 'Sign in to save names.';
    const r = setContactName(readContacts(owner), address, name, Date.now());
    if (r.error) return r.error;
    return writeContacts(owner, r.list) ? null : 'Could not save on this device.';
  }, [owner]);
  const replaceAll = useCallback((list: readonly Contact[]) => (owner ? writeContacts(owner, list) : false), [owner]);
  const addContact = useCallback((address: string, name: string): string | null => {
    if (!owner) return 'Sign in to save names.';
    const r = addNewContact(readContacts(owner), address, name, Date.now());
    if (r.error) return r.error;
    return writeContacts(owner, r.list) ? null : 'Could not save on this device.';
  }, [owner]);
  return { owner, contacts, setName, replaceAll, recipients, addContact };
}

// ---------------------------------------------------------------------------
// The device-wide payout index, shared by every recipient field. Built off
// the render path (idle slots, in chunks), refreshed when a field gains focus.
// ---------------------------------------------------------------------------

let sharedIndex: RecipientIndex | null = null;
let building: Promise<void> | null = null;
const indexListeners = new Set<() => void>();

function publish(next: RecipientIndex) {
  sharedIndex = next;
  for (const l of indexListeners) l();
}

function readPayoutSources(): PayoutRecord[][] {
  const withdrawals = readAllWithdrawRecipients().map((r) => ({ address: r.recipient, timestamp: r.timestamp }));
  const sends = readAllSentTransfers().map((t) => ({ address: t?.recipient, timestamp: t?.timestamp })) as PayoutRecord[];
  return [withdrawals, sends];
}

/** Rebuild the index in the background. Concurrent calls share one build. */
export function refreshRecipientIndex(): Promise<void> {
  if (building) return building;
  const first = sharedIndex === null;
  building = (async () => {
    try {
      // Even the storage read waits for an idle slot: it is a JSON.parse of
      // records that can be long, and the focus that asked for it must paint first.
      await yieldToHost();
      const index = await buildRecipientIndex(readPayoutSources(), {
        // The first build shows rows as they come; a rebuild keeps the
        // complete previous list on screen until the new one is done.
        onPartial: first ? (partial) => publish(new Map(partial)) : undefined,
      });
      if (index) publish(index);
    } catch {
      if (!sharedIndex) publish(new Map());
    } finally {
      building = null;
    }
  })();
  return building;
}

function subscribeIndex(l: () => void) {
  indexListeners.add(l);
  return () => { indexListeners.delete(l); };
}
const getIndex = () => sharedIndex;

/** The app's own contracts on a chain: an address that is one of these on a row is not a recipient. */
function contractAddressesOn(chainId: number | undefined): string[] {
  if (!chainId) return [];
  const out: string[] = [];
  try { out.push(getWithdrawalProcessorAddress(chainId)); } catch { /* no deployment */ }
  try { const s = getSwapProcessorAddress(chainId); if (s) out.push(s); } catch { /* none */ }
  try { out.push(...getPinnedYieldRouters(chainId)); } catch { /* none */ }
  return out;
}

/**
 * Past recipients named by the "Mine" Activity rows, the same merge the
 * Activity panel shows (feed rows attributed to me + note-lineage rows). It
 * reads the rows PoolsProvider already holds; it adds no request.
 */
function useActivityPayouts(): { records: PayoutRecord[]; loading: boolean } {
  const { data, isLoading } = usePools();
  const { filterMineEvents } = useMyTransactionOwnership();
  const records = useMemo(() => {
    const mine = mergeMyTransactions(
      filterMineEvents(data.transactions, { internalTxHashes: data.internalTxHashes, spendClassificationPending: data.spendClassificationPending }),
      data.lineageRows,
      data.anchorTxHashes,
    );
    return payoutRecordsFromActivity(mine, { contractAddresses: contractAddressesOn });
  }, [data.transactions, data.lineageRows, data.internalTxHashes, data.spendClassificationPending, data.anchorTxHashes, filterMineEvents]);
  // Not settled while the feed is loading or own spends are still being classified.
  return { records, loading: isLoading || data.spendClassificationPending };
}

/**
 * Suggestions for one recipient field. Renders at once with whatever index is
 * ready (none on a cold start), and warms the index in an idle slot on mount.
 */
export function useRecipientSuggestions(opts: {
  formats: readonly AddressFormat[];
  query: string;
  exclude?: readonly string[];
  limit?: number;
}): { suggestions: RecipientSuggestion[]; contacts: Contact[]; refresh: () => void; ready: boolean; activityLoading: boolean } {
  const { contacts, recipients } = useContacts();
  // The snapshot is the index itself: every publish is a new Map.
  const deviceIndex = useSyncExternalStore(subscribeIndex, getIndex, getIndex);
  // Reactive: a new Activity row set (rows arriving after focus, a sync)
  // recomputes the list while it is open. Nothing is cached across an
  // unsettled source; the state below says 'loading' instead of 'empty'.
  const { records: activity, loading: activityLoading } = useActivityPayouts();
  // Recipient history: within a day, the stored order breaks ties.
  const history = useMemo(() => recipients.map((r, i) => ({ address: r.address, timestamp: r.lastUsedAt + (recipients.length - i) })), [recipients]);
  const index = useMemo(() => withRecords(withRecords(deviceIndex, history), activity), [deviceIndex, history, activity]);
  useEffect(() => { void refreshRecipientIndex(); }, []);
  const formatsKey = opts.formats.join(',');
  const excludeKey = (opts.exclude ?? []).join(',');
  const suggestions = useMemo(
    () => rankRecipientSuggestions(index, contacts, { formats: formatsKey ? formatsKey.split(',') as AddressFormat[] : [], query: opts.query, exclude: excludeKey ? excludeKey.split(',') : undefined, limit: opts.limit }),
    [index, contacts, formatsKey, opts.query, excludeKey, opts.limit],
  );
  const refresh = useCallback(() => { void refreshRecipientIndex(); }, []);
  // Ready once the first index build has published (it may be empty).
  return { suggestions, contacts, refresh, ready: deviceIndex !== null, activityLoading };
}
