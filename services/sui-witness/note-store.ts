/**
 * Owner-namespaced persistence for Sui Privacy Pools notes (browser-safe).
 *
 * A successful Sui deposit/transact returns only a tx digest; the note (its
 * commitment + the secrets needed to later spend/withdraw/ragequit it) lives
 * only in the client. Without persistence it is unrecoverable (the EVM path's
 * `loadStoredAccountExport` is the analog this mirrors). Notes are namespaced by
 * the owner Sui address so two accounts in the same browser never collide
 * (F11 owner namespacing, matches the SDK `storage-namespace` test intent).
 *
 * Stored as plain JSON in localStorage (web) — bigints are serialized as decimal
 * strings. This holds note SECRETS, so it is the same trust model as the EVM
 * account export already persisted by sdk-provider; back-up/export remains the
 * user's responsibility.
 */
import { Platform } from 'react-native';

/** Lifecycle status of a stored note (mirrors the EVM NoteStatus intent). */
export type SuiNoteStatus = 'active' | 'spent';

/** A persisted Sui note plus the secrets required to spend it later. */
export interface StoredSuiNote {
  /** Note commitment (decimal string). Unique key within an owner namespace. */
  commitment: string;
  /** Note value in base units (decimal string). */
  value: string;
  /** Token id (decimal string). */
  tokenId: string;
  /** Note label (decimal string). */
  label: string;
  /** Per-note secret (decimal string). */
  noteSecret: string;
  /** Deposit secret used to derive the label (decimal string; deposits only). */
  depositSecret?: string;
  /** Owner address as a field element (decimal string). */
  ownerAddress: string;
  /** Move coin type the note's value is denominated in (e.g. 0x2::sui::SUI). */
  coinType: string;
  status: SuiNoteStatus;
  /** Tx digest that created the note. */
  txDigest?: string;
  /** Insertion timestamp (seconds) of the note's state-tree leaf, if known. */
  timestamp?: string;
  /** State-tree leaf index of the note's commitment leaf, if known. */
  leafIndex?: number;
  /** Whether the note's label was registered with the on-chain ASP registry. */
  aspRegistered?: boolean;
  /**
   * Whether the note's label is in the ASP association set (spendable).
   * Maintained by use-sui-notes against the live set: true/false once
   * checked, undefined = not yet checked (treated as spendable, matching
   * pre-flag behavior).
   */
  aspApproved?: boolean;
}

function storageGetItem(key: string): string | null {
  if (Platform.OS === 'web') {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  return null;
}

function storageSetItem(key: string, value: string): void {
  if (Platform.OS === 'web') {
    try {
      localStorage.setItem(key, value);
    } catch {
      // quota exceeded or restricted mode — non-fatal
    }
  }
}

/** Owner-namespaced storage key (lower-cased address). */
function suiNotesKey(ownerAddress: string): string {
  return `ppv2_sui_notes_${ownerAddress.toLowerCase()}`;
}

// --- Cross-instance reactivity ---
// A same-tab localStorage write does NOT fire a `storage` event, so independent
// useSuiNotes() instances (header, pools-provider, transactions) would each keep
// serving a stale in-memory copy until their own next refetch/30s tick. Every
// write broadcasts here so all instances re-read immediately — this is what
// makes the ↻ sync (and a fresh deposit/exit) update every view at once.
type SuiNotesListener = (ownerAddress: string) => void;
const suiNotesListeners = new Set<SuiNotesListener>();

/** Subscribe to note-store writes. Returns an unsubscribe fn. */
export function subscribeSuiNotes(listener: SuiNotesListener): () => void {
  suiNotesListeners.add(listener);
  return () => { suiNotesListeners.delete(listener); };
}

function notifySuiNotesChanged(ownerAddress: string): void {
  for (const listener of suiNotesListeners) {
    try { listener(ownerAddress); } catch { /* a bad listener must not break a write */ }
  }
}

/** Load all stored notes for an owner (empty array if none / unparseable). */
export function loadSuiNotes(ownerAddress: string): StoredSuiNote[] {
  if (!ownerAddress) return [];
  try {
    const raw = storageGetItem(suiNotesKey(ownerAddress));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredSuiNote[]) : [];
  } catch {
    return [];
  }
}

/** Persist the full note set for an owner (overwrites). */
export function saveSuiNotes(ownerAddress: string, notes: StoredSuiNote[]): void {
  if (!ownerAddress) return;
  try {
    storageSetItem(suiNotesKey(ownerAddress), JSON.stringify(notes));
  } catch {
    // serialization failure — non-fatal
  }
  notifySuiNotesChanged(ownerAddress);
}

/**
 * Upsert a note by commitment (within the owner namespace). Returns the updated
 * set. A note that re-appears (same commitment) is replaced, so re-running
 * discovery never duplicates.
 */
export function upsertSuiNote(ownerAddress: string, note: StoredSuiNote): StoredSuiNote[] {
  const notes = loadSuiNotes(ownerAddress);
  const idx = notes.findIndex((n) => n.commitment === note.commitment);
  if (idx >= 0) {
    notes[idx] = { ...notes[idx], ...note };
  } else {
    notes.push(note);
  }
  saveSuiNotes(ownerAddress, notes);
  return notes;
}

/** Mark a set of commitments spent (e.g. after a transact/withdraw/ragequit). */
export function markSuiNotesSpent(ownerAddress: string, commitments: string[]): StoredSuiNote[] {
  const spent = new Set(commitments);
  const notes = loadSuiNotes(ownerAddress).map((n) =>
    spent.has(n.commitment) ? { ...n, status: 'spent' as const } : n,
  );
  saveSuiNotes(ownerAddress, notes);
  return notes;
}
