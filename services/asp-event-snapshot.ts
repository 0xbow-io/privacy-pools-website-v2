/**
 * ASP event-snapshot cursor — PURE module (no SDK / react-native imports,
 * bun-testable).
 *
 * asp-v2 defines `snapshotBlockNumber` as "the block every INCLUDED section is
 * indexed through": the MIN over those sections' `last_synced_block` rows,
 * capped at `untilBlock`. Those are SCAN heads, so they advance through empty
 * ranges — which is exactly what a chain-tail top-up needs as its resume point,
 * and what the highest block among the returned ROWS is not. A section that has
 * never synced contributes 0, so a 0 cursor means "trust nothing, scan it all".
 *
 * Read by `ChunkedRPCInteractor.fetchFromASP` (services/sdk-setup.ts), the one
 * snapshot reader the website still owns: the SDK prefers the ASP for Note
 * events and for note status itself, but still scans pool/keystore leaves over
 * RPC. When that lands upstream — the SDK already accepts `stateLeafCacheSeed` /
 * `keystoreLeafCacheSeed`, so the shape exists — this module and the fast path
 * both go away.
 *
 * The row-shaping that used to live here is gone: SDK b2a37959's
 * `parseEventSnapshotTolerant` owns per-row validation now, and asp-v2 436e9f09
 * fixed the duplicate deposit rows that made it necessary. See SDK_PATCHES.md.
 */

/**
 * The block the ASP has indexed the payload's included sections through, or
 * null when the response carries no usable cursor (missing, unparseable, or
 * 0 — a section that has never synced).
 *
 * This is the ADVERTISED watermark and nothing more: a number the server sends
 * about itself. It advances through empty ranges, which is exactly what the
 * leaf sweep needs to resume a quiet pool cheaply (services/sdk-setup.ts), and
 * it is exactly what must NOT be trusted on its own by anything deciding
 * whether a note is still spendable — see newestSnapshotRowBlock below and its
 * use in services/onchain-note-index.ts.
 */
export function snapshotCursor(raw: unknown, requiredSections: readonly string[] = []): bigint | null {
  if (requiredSections.some(section => !Array.isArray((raw as Record<string, unknown> | null)?.[section]))) return null;
  const value = (raw as { snapshotBlockNumber?: unknown } | null | undefined)?.snapshotBlockNumber;
  if (value == null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    return null;
  }
  // 0 is asp-v2's "no last_synced_block row for this section yet" reading, not a
  // claim that block 0 is covered. Either way it authorises nothing.
  return parsed > 0n ? parsed : null;
}

/**
 * Coverage the ASP has PROVED by returning a row for it, as opposed to the
 * boundary it advertises. The two differ whenever ingestion lags the scan
 * cursor, and only the proved figure may bound a scan that decides whether a
 * note is spent.
 *
 * The incident this exists for (2026-08-27): the ASP advertised the chain head
 * while its rows lagged six minutes, the tail was computed from the advertised
 * figure, the range came out empty, and a relayed spend was hidden from every
 * consumer. Null when no row names a block — nothing is proved, so nothing may
 * be skipped.
 */
export function newestSnapshotRowBlock(raw: {
  deposits?: readonly { blockNumber?: string }[];
  transacts?: readonly { blockNumber?: string }[];
  ragequits?: readonly { blockNumber?: string }[];
} | null | undefined, advertisedBoundary?: bigint | null): bigint | null {
  let newest: bigint | null = null;
  const note = (value?: string) => {
    if (value === undefined) return;
    let parsed: bigint;
    try {
      parsed = BigInt(value);
    } catch {
      return;
    }
    // A row claiming a block ABOVE the snapshot's own advertised boundary is
    // self-inconsistent, and the index already refuses to heal timestamps from
    // one. It must not be allowed to prove coverage either: otherwise a single
    // row with an inflated block number is a lever the ASP can pull to turn
    // "proves less than it claims, scan deeper" into "trust the claim" — the
    // exact defence this function exists to provide (codex, 2026-09-15).
    if (advertisedBoundary != null && parsed > advertisedBoundary) return;
    if (newest === null || parsed > newest) newest = parsed;
  };
  // One pass over the parsed object rather than a hook threaded through the
  // three merge loops: that shape is how the ragequit half went missing.
  for (const row of raw?.deposits ?? []) note(row.blockNumber);
  for (const row of raw?.transacts ?? []) note(row.blockNumber);
  for (const row of raw?.ragequits ?? []) note(row.blockNumber);
  return newest;
}

/**
 * Recheck this many blocks below the snapshot's watermark when discovery reads
 * its Note events from the held snapshot, the same backstop for ingestion
 * races the note index keeps (services/onchain-note-index.ts).
 */
export const SNAPSHOT_NOTE_OVERLAP_BLOCKS = 300n;

export interface SnapshotNoteEvent {
  blockNumber: `0x${string}`;
  txHash: `0x${string}`;
  hint: `0x${string}`;
  ephemeralPubKey: `0x${string}`;
  encryptedPayload: `0x${string}`;
}

const HEX = /^0x[0-9a-fA-F]*$/;

/**
 * A snapshot's Note section in the shape the SDK's own Note-event reader
 * returns: block numbers as hex, rows with an empty ciphertext dropped. A row
 * that is not a Note event throws, as a malformed ASP response does there, and
 * discovery then reads the range from the chain instead of skipping a note.
 */
export function noteEventsFromSnapshot(rows: unknown): SnapshotNoteEvent[] {
  if (!Array.isArray(rows)) throw new Error('snapshot carries no Note section');
  const events: SnapshotNoteEvent[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    const { txHash, hint, ephemeralPubKey, encryptedPayload, blockNumber } = row ?? {};
    if (encryptedPayload === '' || encryptedPayload === '0x') continue;
    if (![txHash, hint, ephemeralPubKey, encryptedPayload].every((v) => typeof v === 'string' && HEX.test(v))) {
      throw new Error('malformed Note row in the event snapshot');
    }
    if (typeof blockNumber !== 'string' && typeof blockNumber !== 'number') {
      throw new Error('Note row without a block number in the event snapshot');
    }
    events.push({
      blockNumber: `0x${BigInt(blockNumber).toString(16)}`,
      txHash: txHash as `0x${string}`,
      hint: hint as `0x${string}`,
      ephemeralPubKey: ephemeralPubKey as `0x${string}`,
      encryptedPayload: encryptedPayload as `0x${string}`,
    });
  }
  return events;
}
