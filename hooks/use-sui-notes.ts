/**
 * Sui notes hook — the Sui-chain analog of `use-notes.ts` (which is EVM/wagmi
 * only and never touches the Sui SDK, so Sui balances always showed empty).
 *
 * Surfaces the connected Sui account's notes + total balance from two sources:
 *   1. Owner-namespaced local persistence (`note-store`) — your own deposits and
 *      change outputs, persisted at creation time (a successful Sui tx returns
 *      only a digest, so without this the note is lost).
 *   2. On-chain discovery (optional, on demand) — `chain-reader.getNoteEvents` +
 *      `getTransactEvents` paginated/fail-closed, then ECDH trial-decrypt via
 *      `note-discovery` against the user's viewing key, to recover notes OTHERS
 *      sent you. Discovered notes are upserted into local persistence.
 *
 * Only ACTIVE notes count toward the balance. The shape (notes + totalValue +
 * refetch) matches what the EVM `useNotes` feeds the UI so a modal can consume
 * either via the chain-router branch.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCurrentAccount, useSuiClient } from '@mysten/dapp-kit';
import { useChainRouter } from '@/hooks/use-chain-router';
import {
  loadSuiNotes,
  upsertSuiNote,
  subscribeSuiNotes,
  type StoredSuiNote,
} from '@/services/sui-witness/note-store';
import { SuiChainReader, type SuiEventEnvelope } from '@/services/sui-witness/chain-reader';
import { fetchSuiApprovedSet } from '@/services/sui-witness/asp-labels';
import { activitySignal } from '@/services/activity-signal';
import { calculateLabelHash } from '@/services/sui-witness/crypto';
import {
  discoveredToStoredNote,
  scanCatchAll,
  verifyDiscoveredCommitment,
  type TransactEvent,
  type DiscoveredNote,
} from '@/services/sui-witness/note-discovery';

export interface UseSuiNotesResult {
  /** All persisted notes for the connected Sui account. */
  notes: StoredSuiNote[];
  /** Total value of ACTIVE notes (base units). */
  totalValue: bigint;
  /** Count of ACTIVE notes. */
  activeCount: bigint;
  isLoading: boolean;
  /** Re-read persisted notes (call after a successful Sui tx). */
  refetch: () => void;
  /** Run on-chain discovery (ECDH trial-decrypt) for the given viewing key. */
  discover: (viewingPrivKey: string) => Promise<DiscoveredNote[]>;
  discovering: boolean;
  discoverError: string | null;
}

/** Decode a Move `vector<u8>` event field (number[] | base64 string) to bytes. */
function toBytes(value: unknown): Uint8Array {
  if (value == null) return new Uint8Array(0);
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  if (typeof value === 'string') {
    // @mysten/sui can surface a vector<u8> as base64; tolerate both.
    try {
      const bin = typeof atob === 'function' ? atob(value) : '';
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      return new Uint8Array(0);
    }
  }
  return new Uint8Array(0);
}

/**
 * Pair each `Transacted` event's output commitments with the `NoteEvent` blobs
 * emitted in the same transaction (one NoteEvent per output, in order). Returns
 * the parallel-array `TransactEvent[]` discovery expects.
 */
function pairEvents(
  transacted: SuiEventEnvelope[],
  noteEvents: SuiEventEnvelope[],
): TransactEvent[] {
  // Group NoteEvents by their source tx digest, preserving emit order.
  const byDigest = new Map<string, Array<{ hint: Uint8Array; data: Uint8Array }>>();
  for (const ev of noteEvents) {
    const digest = ev.id?.txDigest ?? '';
    const f = ev.parsedJson ?? {};
    const list = byDigest.get(digest) ?? [];
    list.push({ hint: toBytes(f.hint), data: toBytes(f.data) });
    byDigest.set(digest, list);
  }

  const out: TransactEvent[] = [];
  for (const ev of transacted) {
    const digest = ev.id?.txDigest ?? '';
    const f = ev.parsedJson ?? {};
    const commitments = Array.isArray(f.output_commitments)
      ? (f.output_commitments as unknown[]).map((c) => BigInt(c as string))
      : [];
    const blobs = byDigest.get(digest) ?? [];
    // Only pair when counts line up; a mismatch is left to discovery's
    // fail-closed validation rather than silently mis-pairing.
    out.push({
      txDigest: digest,
      outputCommitments: commitments,
      noteHints: commitments.map((_, i) => blobs[i]?.hint ?? new Uint8Array(0)),
      noteData: commitments.map((_, i) => blobs[i]?.data ?? new Uint8Array(0)),
    });
  }
  return out;
}

export function useSuiNotes(): UseSuiNotesResult {
  const { isSui, activeChain } = useChainRouter();
  const account = useCurrentAccount();
  const client = useSuiClient();
  const ownerAddress = account?.address ?? '';

  const [revision, setRevision] = useState(0);
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);

  const notes = useMemo<StoredSuiNote[]>(() => {
    if (!isSui || !ownerAddress) return [];
    return loadSuiNotes(ownerAddress);
    // revision forces a re-read after writes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSui, ownerAddress, revision]);

  const { totalValue, activeCount } = useMemo(() => {
    let total = 0n;
    let active = 0n;
    for (const n of notes) {
      if (n.status === 'active') {
        total += BigInt(n.value);
        active += 1n;
      }
    }
    return { totalValue: total, activeCount: active };
  }, [notes]);

  const refetch = useCallback(() => setRevision((r) => r + 1), []);

  const discover = useCallback(
    async (viewingPrivKey: string): Promise<DiscoveredNote[]> => {
      if (!isSui || !ownerAddress) return [];
      const contracts = activeChain?.suiContracts;
      if (!contracts) return [];
      setDiscovering(true);
      setDiscoverError(null);
      try {
        const reader = new SuiChainReader({
          client,
          packageId: contracts.packageId,
          poolId: contracts.poolObjectId,
        });
        const [transacted, noteEvents] = await Promise.all([
          reader.getTransactEvents(),
          reader.getNoteEvents(),
        ]);
        const paired = pairEvents(transacted, noteEvents);
        const found = await scanCatchAll(paired, viewingPrivKey);
        const verified: DiscoveredNote[] = [];
        for (const d of found) {
          // A payload can decrypt cleanly under our viewing key yet not hash
          // to the event's output commitment (forged/mismatched note data).
          // Persisting it would create an unspendable "active" note — skip.
          if (!(await verifyDiscoveredCommitment(ownerAddress, d))) {
            console.warn(
              `[SuiNotes] Discarding discovered note ${d.commitment} (tx ${d.txDigest}): `
              + 'decrypted fields do not reconstruct the output commitment',
            );
            continue;
          }
          // Owner field = addressToU256(this account) — the value the sender
          // bound into the commitment. Persisting '0' here made discovered
          // notes unspendable (the spend path recomputes the commitment from
          // ownerAddress + noteSecret and derived a different leaf).
          upsertSuiNote(ownerAddress, discoveredToStoredNote(ownerAddress, d));
          verified.push(d);
        }
        if (verified.length > 0) refetch();
        return verified;
      } catch (err) {
        setDiscoverError(err instanceof Error ? err.message : String(err));
        return [];
      } finally {
        setDiscovering(false);
      }
    },
    [isSui, ownerAddress, activeChain, client, refetch],
  );

  // Re-read on account / chain switch.
  useEffect(() => {
    setRevision((r) => r + 1);
  }, [ownerAddress, isSui]);

  // Re-read whenever ANY instance writes the note store (deposit, exit,
  // discovery/sync) so every view updates at once instead of drifting until its
  // own next tick.
  useEffect(() => {
    return subscribeSuiNotes((changedOwner) => {
      if (!ownerAddress || changedOwner.toLowerCase() === ownerAddress.toLowerCase()) {
        setRevision((r) => r + 1);
      }
    });
  }, [ownerAddress]);

  // Maintain each stored note's aspApproved flag against the live association
  // set (30s cadence). Spendability requires set membership, so selection and
  // balance displays exclude known-unapproved notes; the flag flips to true
  // shortly after the ASP admits the label. Fetch failures leave flags as-is.
  useEffect(() => {
    if (!isSui || !ownerAddress) return;
    let cancelled = false;
    const sync = async () => {
      // Nobody using the tab: skip this tick, the next one runs on cadence.
      if (!activitySignal().isActive()) return;
      try {
        const stored = loadSuiNotes(ownerAddress);
        const unresolved = stored.filter((n) => n.status === 'active' && n.label);
        if (unresolved.length === 0) return;
        const set = await fetchSuiApprovedSet();
        if (set === null || cancelled) return;
        const values = new Set(set.values.map(String));
        let changed = false;
        for (const n of unresolved) {
          const key = set.kind === 'labels' ? BigInt(n.label) : await calculateLabelHash(BigInt(n.label));
          const approved = values.has(String(key));
          if (n.aspApproved !== approved) {
            upsertSuiNote(ownerAddress, { ...n, aspApproved: approved });
            changed = true;
          }
        }
        if (changed && !cancelled) setRevision((r) => r + 1);
      } catch {
        // transient — retry on the next tick
      }
    };
    void sync();
    const timer = setInterval(sync, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isSui, ownerAddress]);

  return {
    notes,
    totalValue,
    activeCount,
    isLoading: false,
    refetch,
    discover,
    discovering,
    discoverError,
  };
}
