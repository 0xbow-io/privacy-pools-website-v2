import { useCallback, useEffect, useMemo } from 'react';
import { useAccount } from 'wagmi';
import { useSessionChainId } from '@/hooks/use-session-chain-id';
import { NoteStatus } from '@/services/sdk-types';
import type { Note, Address, Hash, Hex } from '@/services/sdk-types';
import { loadStoredAccountExport, useSdkContext } from '@/components/sdk-provider';
import { useDebug } from '@/components/debug-provider';
import { useChainRouter } from '@/hooks/use-chain-router';
import { useSuiNotes } from '@/hooks/use-sui-notes';
import { useStellarSession } from '@/hooks/use-stellar-session';
import type { StoredSuiNote } from '@/services/sui-witness/note-store';
import { managerOwnsAccount } from '@/services/note-source';

/** Render a decimal bigint string as a 0x-hex value the Note shape expects. */
function toHex(decimal: string): Hex {
  try {
    return `0x${BigInt(decimal).toString(16)}` as Hex;
  } catch {
    return '0x0' as Hex;
  }
}

/** Map a persisted Sui note into the UI `Note` shape used by the EVM path. */
function suiNoteToNote(n: StoredSuiNote): Note {
  return {
    commitment: toHex(n.commitment) as Hash,
    value: toHex(n.value),
    tokenId: toHex(n.tokenId) as Address,
    label: toHex(n.label) as Hash,
    status: n.status === 'spent' ? NoteStatus.SPENT : NoteStatus.ACTIVE,
    ownerAddress: toHex(n.ownerAddress) as Address,
    noteSecret: toHex(n.noteSecret),
    isOwned: true,
    createdAtBlock: '0x0' as Hex,
    spentAtBlock: null,
    txHash: (n.txDigest ? n.txDigest : '0x0') as Hash,
    parentCommitmentHash: null,
  };
}

interface NoteFilters {
  status?: NoteStatus;
  tokenId?: Address;
}

interface UseNotesResult {
  notes: Note[];
  isLoading: boolean;
  totalValue: bigint;
  activeCount: number;
  refetch: () => void;
}

export function useNotes(filters?: NoteFilters): UseNotesResult {
  const { noteManager, isInitialized, notesRevision, refreshNotes, sessionAddress, sessionTarget } = useSdkContext();
  const { address: walletAddress } = useAccount();
  // The SESSION's chain (connector -> app selection -> store) — the stored
  // account export is keyed per (address, chainId) and MUST use the same
  // chain the session writes, or this hook reads an empty foreign bucket.
  const chainId = useSessionChainId();
  const { log } = useDebug();
  const accountAddress = sessionAddress ?? walletAddress;
  // Sui chain branch: when the active app chain is Sui, surface the Sui notes
  // (persisted + discovered) mapped into the same `Note` shape the EVM path
  // feeds the portfolio / note-selection UIs.
  const { isSui, isStellar } = useChainRouter();
  const suiNotes = useSuiNotes();
  // Stellar: the SDK's own Note objects from the shared account store (the
  // tokenId is the asset's C… contract id rather than an EVM address).
  const stellar = useStellarSession();

  // Stellar: no fetch here. Callers invoke refetch right after a flow or on a
  // screen change, and a chain read at that moment would mark it (AGENTS.md
  // rule 2). The shared account already published the flow's local note
  // state and syncs on its fixed clock (hooks/use-stellar-session.ts).
  const refetch = useCallback(() => {
    if (isStellar) return;
    if (isSui) suiNotes.refetch();
    else refreshNotes();
  }, [isSui, isStellar, suiNotes, refreshNotes]);

  const stellarNotes = useMemo(() => {
    if (!isStellar) return [] as Note[];
    return (stellar.notes as unknown as Note[]).filter((note) => {
      if (filters?.status !== undefined && note.status !== filters.status) return false;
      if (filters?.tokenId !== undefined && note.tokenId !== filters.tokenId) return false;
      return true;
    });
  }, [isStellar, stellar.notes, filters?.status, filters?.tokenId]);

  const suiMappedNotes = useMemo(() => {
    if (!isSui) return [] as Note[];
    return suiNotes.notes
      .map(suiNoteToNote)
      .filter((note) => {
        if (filters?.status !== undefined && note.status !== filters.status) return false;
        if (filters?.tokenId !== undefined && note.tokenId !== filters.tokenId) return false;
        return true;
      });
  }, [isSui, suiNotes.notes, filters?.status, filters?.tokenId]);

  const storedNotes = useMemo(() => {
    if (!accountAddress) return [];
    const stored = loadStoredAccountExport(accountAddress, chainId);
    return stored?.notes ?? [];
  }, [accountAddress, chainId, notesRevision]);

  const notes = useMemo(() => {
    // On Sui / Stellar, the notes come from that chain's store (already filtered).
    if (isStellar) return stellarNotes;
    if (isSui) return suiMappedNotes;

    // The live manager is only THIS account's if the session it was built for
    // is the account on screen. The two disagree for exactly one render on a
    // wallet switch or sign-out (see services/note-source.ts), and in that
    // render the old wallet's notes were reported under the new identity, so
    // the balance hero cached one wallet's total as another's (Pat, 2026-08-27).
    const managerOwned = managerOwnsAccount({
      hasManager: !!noteManager, isInitialized, accountAddress, sessionTarget,
    });
    const liveNotes = managerOwned && noteManager ? noteManager.getNotes() : [];
    const sourceNotes = liveNotes.length > 0 || storedNotes.length === 0 ? liveNotes : storedNotes;

    return sourceNotes.filter((note) => {
      if (filters?.status !== undefined && note.status !== filters.status) return false;
      if (filters?.tokenId !== undefined && note.tokenId !== filters.tokenId) return false;
      return true;
    });
  }, [isSui, isStellar, stellarNotes, suiMappedNotes, noteManager, isInitialized, accountAddress, sessionTarget, filters?.status, filters?.tokenId, notesRevision, storedNotes]);

  const { totalValue, activeCount } = useMemo(() => {
    let total = 0n;
    let active = 0;
    for (const note of notes) {
      total += BigInt(note.value);
      if (note.status === NoteStatus.ACTIVE) {
        active++;
      }
    }
    return { totalValue: total, activeCount: active };
  }, [notes]);

  useEffect(() => {
    const liveNotes = noteManager && isInitialized ? noteManager.getNotes() : [];
    const source = liveNotes.length > 0 || storedNotes.length === 0 ? 'live' : 'stored';

    log('debug', 'UseNotes', 'Resolved note source', {
      address: accountAddress?.toLowerCase() ?? null,
      chainId,
      source,
      liveNotesCount: liveNotes.length,
      storedNotesCount: storedNotes.length,
      returnedNotesCount: notes.length,
      filters: {
        status: filters?.status ?? null,
        tokenId: filters?.tokenId ?? null,
      },
      notes: notes.map((note) => ({
        commitment: note.commitment,
        tokenId: note.tokenId,
        status: note.status,
        value: note.value,
        txHash: note.txHash,
      })),
    });
  }, [accountAddress, chainId, filters?.status, filters?.tokenId, isInitialized, log, noteManager, notes, storedNotes]);

  return {
    notes,
    // Sui notes come from synchronous local persistence (no SDK init gate).
    isLoading: isStellar
      ? stellar.status === 'unlocking' || (stellar.unlocked && stellar.lastSyncedAt === null)
      : isSui ? suiNotes.isLoading : (!isInitialized && storedNotes.length === 0),
    totalValue,
    activeCount,
    refetch,
  };
}
