import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useSdkContext } from '@/components/sdk-provider';
import { setContactName, type AddressFormat, type Contact } from '@/services/address-book-core';
import { getContactsVersion, readContacts, subscribeContacts, writeContacts } from '@/services/address-book-store';
import { buildRecipientIndex, rankRecipientSuggestions, yieldToHost, type PayoutRecord, type RecipientIndex, type RecipientSuggestion } from '@/services/recipient-suggestions';
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
} {
  const { sessionAddress } = useSdkContext();
  const owner = sessionAddress ?? null;
  // The version is an explicit input: a read the compiler cannot see change
  // must not be memoized on `owner` alone.
  const version = useSyncExternalStore(subscribeContacts, getContactsVersion, getContactsVersion);
  const contacts = useMemo(() => { void version; return readContacts(owner); }, [owner, version]);
  const setName = useCallback((address: string, name: string): string | null => {
    if (!owner) return 'Sign in to save names.';
    const r = setContactName(readContacts(owner), address, name, Date.now());
    if (r.error) return r.error;
    return writeContacts(owner, r.list) ? null : 'Could not save on this device.';
  }, [owner]);
  const replaceAll = useCallback((list: readonly Contact[]) => (owner ? writeContacts(owner, list) : false), [owner]);
  return { owner, contacts, setName, replaceAll };
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

/**
 * Suggestions for one recipient field. Renders at once with whatever index is
 * ready (none on a cold start), and warms the index in an idle slot on mount.
 */
export function useRecipientSuggestions(opts: {
  formats: readonly AddressFormat[];
  query: string;
  exclude?: readonly string[];
  limit?: number;
}): { suggestions: RecipientSuggestion[]; contacts: Contact[]; refresh: () => void } {
  const { contacts } = useContacts();
  // The snapshot is the index itself: every publish is a new Map.
  const index = useSyncExternalStore(subscribeIndex, getIndex, getIndex);
  useEffect(() => { void refreshRecipientIndex(); }, []);
  const formatsKey = opts.formats.join(',');
  const excludeKey = (opts.exclude ?? []).join(',');
  const suggestions = useMemo(
    () => rankRecipientSuggestions(index, contacts, { formats: formatsKey ? formatsKey.split(',') as AddressFormat[] : [], query: opts.query, exclude: excludeKey ? excludeKey.split(',') : undefined, limit: opts.limit }),
    [index, contacts, formatsKey, opts.query, excludeKey, opts.limit],
  );
  const refresh = useCallback(() => { void refreshRecipientIndex(); }, []);
  return { suggestions, contacts, refresh };
}
