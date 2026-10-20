/**
 * The file a debug recording is saved as.
 *
 * The debug console keeps a 2000-entry ring buffer, which a long manual run
 * outgrows, so a recording keeps its own copy of every entry between Start and
 * Stop (Pat, 2026-09-24) and this turns it into one JSON document: the run's
 * context first, then every entry in order with its time since the start.
 *
 * JSON rather than CSV because entries carry nested payloads. Payloads are made
 * JSON-safe here: a bigint becomes its decimal string, a repeated object
 * becomes "[circular]", and anything that still cannot serialise becomes its
 * String() form, so one odd payload never loses the whole recording.
 *
 * PURE module (no react-native imports) so it is bun-testable.
 */
import type { DebugLogEntry } from '@/services/debug-log-filter';
import { redactRecordingParts, REDACTION_LEVEL_INFO, type RedactionLevel } from '@/services/debug-redaction';

/** Hard ceiling on one recording, so a forgotten Record cannot eat the tab. */
export const MAX_RECORDED_ENTRIES = 50_000;

export type DebugRecordingMeta = {
  startedAt: number;
  stoppedAt: number;
  environment: string;
  url?: string;
  userAgent?: string;
  /**
   * App state at Start and at Stop (services/debug-snapshots.ts): identity and
   * keys, every note on every chain, balances, and the activity table rows.
   */
  snapshots?: { atStart?: Record<string, unknown>; atStop?: Record<string, unknown> };
  /** The log hit its entry or byte budget (BoundedDebugLog). */
  truncated?: boolean;
};

/** The warning the save prompt shows: the file carries spend-grade keys. */
export const RECORDING_SECRET_WARNING = 'Contains your account key and all your keys. Anyone with this file can spend your funds. Share it only with the team and with a test account with less than $100. Never use this account again for anything else than testing.';

/** A JSON-safe copy of a log payload. */
export function jsonSafe(value: unknown): unknown {
  if (value === undefined) return undefined;
  const seen = new WeakSet<object>();
  try {
    return JSON.parse(JSON.stringify(value, (_key, v) => {
      if (typeof v === 'bigint') return v.toString();
      if (v instanceof Error) return { name: v.name, message: v.message };
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[circular]';
        seen.add(v);
      }
      return v;
    }));
  } catch {
    return String(value);
  }
}

/**
 * The recording as a JSON document, redacted at `level`
 * (services/debug-redaction.ts). The RPC key is removed at every level; Full
 * keeps everything else and says the file can spend the funds.
 */
export function buildDebugRecording(entries: readonly DebugLogEntry[], meta: DebugRecordingMeta, level: RedactionLevel = 'full'): string {
  const parts = redactRecordingParts({
    entries: entries.map((e) => ({
      at: new Date(e.timestamp).toISOString(),
      sinceStartMs: Math.max(0, e.timestamp - meta.startedAt),
      level: e.level,
      tag: e.tag,
      message: e.message,
      ...(e.data !== undefined ? { data: jsonSafe(e.data) } : {}),
    })),
    snapshots: meta.snapshots ?? {},
    ...(meta.url ? { url: meta.url } : {}),
  }, level);
  const full = level === 'full';
  return JSON.stringify({
    kind: 'ppv2-debug-recording',
    version: 1,
    startedAt: new Date(meta.startedAt).toISOString(),
    stoppedAt: new Date(meta.stoppedAt).toISOString(),
    durationMs: Math.max(0, meta.stoppedAt - meta.startedAt),
    environment: meta.environment,
    ...(parts.url ? { url: parts.url } : {}),
    ...(meta.userAgent ? { userAgent: meta.userAgent } : {}),
    redaction: level,
    containsSecrets: full,
    warning: full ? RECORDING_SECRET_WARNING : REDACTION_LEVEL_INFO[level].statement,
    entryCount: entries.length,
    truncated: meta.truncated ?? entries.length >= MAX_RECORDED_ENTRIES,
    entries: parts.entries,
    snapshots: parts.snapshots,
  }, null, 2);
}

/** `ppv2-recording-2026-09-24T13-05-11-000Z.json`, `.redacted.json` below Full. */
export function debugRecordingFileName(startedAt: number, level: RedactionLevel = 'full'): string {
  const ext = level === 'full' ? '.json' : '.redacted.json';
  return `ppv2-recording-${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}${ext}`;
}

/** Byte budget for one bounded log (a rough UTF-16 estimate). */
export const DEBUG_LOG_BYTE_BUDGET = 32 * 1024 * 1024;

/** Rough in-memory size of an entry: its text plus its serialised payload. */
export function estimateEntryBytes(entry: DebugLogEntry): number {
  let dataLen = 0;
  if (entry.data !== undefined) {
    if (typeof entry.data === 'string') dataLen = entry.data.length;
    else {
      try { dataLen = JSON.stringify(entry.data, (_k, v) => (typeof v === 'bigint' ? String(v) : v))?.length ?? 0; } catch { dataLen = 256; }
    }
  }
  return 2 * (entry.message.length + entry.tag.length + dataLen) + 64;
}

/**
 * A log bounded by entries AND bytes. `drop-oldest` keeps the latest entries
 * (the everything-since-debug log: a long session must not eat the tab);
 * `stop` keeps the first ones and says it was cut (a recording is read from
 * its start).
 */
export class BoundedDebugLog {
  readonly entries: DebugLogEntry[] = [];
  truncated = false;
  private bytes = 0;
  private readonly sizes: number[] = [];

  constructor(
    private readonly mode: 'drop-oldest' | 'stop',
    private readonly maxEntries = MAX_RECORDED_ENTRIES,
    private readonly maxBytes = DEBUG_LOG_BYTE_BUDGET,
  ) {}

  push(entry: DebugLogEntry): void {
    const size = estimateEntryBytes(entry);
    if (this.mode === 'stop') {
      if (this.truncated) return;
      if (this.entries.length >= this.maxEntries || this.bytes + size > this.maxBytes) {
        this.truncated = true;
        return;
      }
    }
    this.entries.push(entry);
    this.sizes.push(size);
    this.bytes += size;
    if (this.mode === 'drop-oldest') {
      let drop = 0;
      while ((this.entries.length - drop > this.maxEntries || this.bytes > this.maxBytes) && drop < this.entries.length - 1) {
        this.bytes -= this.sizes[drop];
        drop += 1;
      }
      if (drop > 0) {
        this.entries.splice(0, drop);
        this.sizes.splice(0, drop);
        this.truncated = true;
      }
    }
  }
}
