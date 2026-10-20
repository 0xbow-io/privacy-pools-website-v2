/**
 * Debug-console log filtering: the level chip, the free-text search, and the
 * one line serialiser the on-screen rows, `copy` and `save` all share.
 *
 * PURE. It lives here rather than inline in components/debug-provider.tsx
 * because CI only runs `bun test services scripts` — filter logic written
 * inside the overlay would never be executed by a test again, and this is the
 * code someone leans on precisely when the app is already misbehaving.
 */

export type DebugLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type DebugLogEntry = {
  timestamp: number;
  level: DebugLogLevel;
  tag: string;
  message: string;
  data?: unknown;
};

/** 'all' is the chip's no-op position, not a level any entry can carry. */
export type DebugLogLevelFilter = DebugLogLevel | 'all';

export type DebugLogFilter = {
  level?: DebugLogLevelFilter;
  query?: string;
};

/**
 * JSON for a payload that must never throw.
 *
 * The console logs raw SDK and viem objects: a `bigint` amount (JSON.stringify
 * throws outright on those) or a self-referencing client would otherwise take
 * down the render of the whole buffer, i.e. destroy exactly the evidence
 * someone opened the console to read.
 */
export function stringifyLogData(data: unknown): string {
  if (data === undefined) return '';
  try {
    // String(v) rather than v.toString() so the replacer stays total.
    return JSON.stringify(data, bigintSafe) ?? String(data);
  } catch {
    return String(data);
  }
}

const bigintSafe = (_key: string, value: unknown) => (typeof value === 'bigint' ? String(value) : value);

export type PayloadTokenKind = 'text' | 'key' | 'string' | 'number' | 'literal' | 'nullish' | 'punctuation';
export type PayloadToken = { kind: PayloadTokenKind; text: string };

/**
 * The values a log row displays, one per console argument. Console entries
 * carry their extra arguments as a JSON array string (services/debug-capture),
 * so that array is unpacked; a capture truncated past the size limit no longer
 * parses and stays one string.
 */
export function debugLogPayloadValues(entry: DebugLogEntry): unknown[] {
  if (entry.data === undefined) return [];
  if (entry.tag === 'console' && typeof entry.data === 'string') {
    try {
      const parsed: unknown = JSON.parse(entry.data);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Truncated capture: shown as the string it is.
    }
  }
  return [entry.data];
}

const PREVIEW_PROPERTIES = 5;
const PREVIEW_STRING_CHARS = 100;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

const ESCAPES: Record<string, string> = { '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/**
 * A string literal the way the browser console writes one: single quotes,
 * double quotes when the text holds a single quote and no double quote, and
 * backslashes, the chosen quote and control characters escaped so a value
 * cannot close its own quotes or break the line.
 */
function quoted(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  const body = text.replace(/[\\\u0000-\u001f]/g, (c) => ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `${quote}${body.split(quote).join(`\\${quote}`)}${quote}`;
}

const keyText = (key: string) => (IDENTIFIER.test(key) ? key : quoted(key));

function scalarToken(value: unknown, maxString: number): PayloadToken | null {
  if (value === null || value === undefined) return { kind: 'nullish', text: String(value) };
  if (typeof value === 'string') return { kind: 'string', text: quoted(clip(value, maxString)) };
  if (typeof value === 'number' || typeof value === 'bigint') return { kind: 'number', text: typeof value === 'bigint' ? `${value}n` : String(value) };
  if (typeof value === 'boolean') return { kind: 'literal', text: String(value) };
  if (typeof value === 'function') return { kind: 'literal', text: 'ƒ' };
  if (typeof value !== 'object') return { kind: 'literal', text: String(value) };
  return null;
}

/**
 * The one-line preview of a row's payload, the way the browser console shows
 * an object before it is expanded: top-level strings as written, objects as
 * `{key: value, …}` with the first few properties, nested objects and arrays
 * abbreviated to `{…}` and `Array(n)`.
 */
export function previewPayloadTokens(values: readonly unknown[]): PayloadToken[] {
  const out: PayloadToken[] = [];
  const nested = (value: unknown) => {
    const scalar = scalarToken(value, PREVIEW_STRING_CHARS);
    if (scalar) out.push(scalar);
    else out.push({ kind: 'punctuation', text: Array.isArray(value) ? `Array(${value.length})` : '{…}' });
  };
  values.forEach((value, i) => {
    if (i > 0) out.push({ kind: 'punctuation', text: ' ' });
    if (typeof value === 'string') {
      out.push({ kind: 'text', text: clip(value, PREVIEW_STRING_CHARS * 2) });
      return;
    }
    const scalar = scalarToken(value, PREVIEW_STRING_CHARS);
    if (scalar) {
      out.push(scalar);
      return;
    }
    if (Array.isArray(value)) {
      out.push({ kind: 'punctuation', text: `(${value.length}) [` });
      value.slice(0, PREVIEW_PROPERTIES).forEach((item, j) => {
        if (j > 0) out.push({ kind: 'punctuation', text: ', ' });
        nested(item);
      });
      out.push({ kind: 'punctuation', text: value.length > PREVIEW_PROPERTIES ? ', …]' : ']' });
      return;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    out.push({ kind: 'punctuation', text: '{' });
    entries.slice(0, PREVIEW_PROPERTIES).forEach(([key, item], j) => {
      if (j > 0) out.push({ kind: 'punctuation', text: ', ' });
      out.push({ kind: 'key', text: keyText(key) });
      out.push({ kind: 'punctuation', text: ': ' });
      nested(item);
    });
    out.push({ kind: 'punctuation', text: entries.length > PREVIEW_PROPERTIES ? ', …}' : '}' });
  });
  return out;
}

const previews = new WeakMap<DebugLogEntry, { values: unknown[]; preview: PayloadToken[] }>();

/**
 * A row's payload values and collapsed preview, built once per entry. The panel
 * redraws every second, and without this each redraw would re-parse every
 * console payload and re-read every SDK object's getters for every row. Cached
 * by entry identity for the reason the search haystack is (see below).
 */
export function debugLogPreview(entry: DebugLogEntry): { values: unknown[]; preview: PayloadToken[] } {
  const cached = previews.get(entry);
  if (cached) return cached;
  const values = debugLogPayloadValues(entry);
  const built = { values, preview: previewPayloadTokens(values) };
  previews.set(entry, built);
  return built;
}

/**
 * The expanded payload: every value in full, indented two spaces, keys
 * unquoted where they are identifiers, as the console's object tree reads.
 * A circular reference prints as `[Circular]` rather than recursing.
 */
export function expandedPayloadTokens(values: readonly unknown[]): PayloadToken[] {
  const out: PayloadToken[] = [];
  const seen = new WeakSet<object>();
  const write = (value: unknown, indent: string) => {
    const scalar = scalarToken(value, Infinity);
    if (scalar) {
      out.push(scalar);
      return;
    }
    const object = value as object;
    if (seen.has(object)) {
      out.push({ kind: 'nullish', text: '[Circular]' });
      return;
    }
    seen.add(object);
    const inner = `${indent}  `;
    const isArray = Array.isArray(object);
    const entries = isArray ? (object as unknown[]).map((item, i) => [String(i), item] as const) : Object.entries(object);
    if (entries.length === 0) {
      out.push({ kind: 'punctuation', text: isArray ? '[]' : '{}' });
    } else {
      out.push({ kind: 'punctuation', text: isArray ? '[\n' : '{\n' });
      entries.forEach(([key, item], i) => {
        out.push({ kind: 'punctuation', text: inner });
        if (!isArray) {
          out.push({ kind: 'key', text: keyText(key) });
          out.push({ kind: 'punctuation', text: ': ' });
        }
        write(item, inner);
        out.push({ kind: 'punctuation', text: i < entries.length - 1 ? ',\n' : '\n' });
      });
      out.push({ kind: 'punctuation', text: `${indent}${isArray ? ']' : '}'}` });
    }
    seen.delete(object);
  };
  values.forEach((value, i) => {
    if (i > 0) out.push({ kind: 'punctuation', text: '\n' });
    if (typeof value === 'string') out.push({ kind: 'text', text: value });
    else write(value, '');
  });
  return out;
}

export function formatDebugLogLine(entry: DebugLogEntry): string {
  const data = stringifyLogData(entry.data);
  const ts = new Date(entry.timestamp).toISOString();
  return `${ts} [${entry.level.toUpperCase()}][${entry.tag}] ${entry.message}${data ? ' ' + data : ''}`;
}

/**
 * The panel's timestamp column: local 24-hour time with milliseconds, always 12
 * characters, so the level and tag columns line up in the monospaced log.
 */
export function formatDebugLogTime(timestamp: number): string {
  const d = new Date(timestamp);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

export function formatDebugLogs(entries: readonly DebugLogEntry[]): string {
  return entries.map((entry) => formatDebugLogLine(entry)).join('\n');
}

/**
 * One lowercased haystack per entry, cached by entry identity.
 *
 * The buffer retains up to 2000 entries (MAX_LOGS) and the search re-filters
 * on every keystroke, so each payload's JSON.stringify has to happen once per
 * ENTRY, not once per entry per keystroke — that serialisation, not the
 * substring scan, is what would make typing lag. Identity is a sound key
 * because the provider pushes a fresh entry object and never mutates it
 * afterwards; a WeakMap lets an entry aged out of the ring buffer take its
 * haystack with it.
 */
const haystacks = new WeakMap<DebugLogEntry, string>();

function parsedOrNone(json: string): unknown[] {
  if (json === '') return [];
  try {
    return [JSON.parse(json)];
  } catch {
    return [];
  }
}

export function debugLogHaystack(entry: DebugLogEntry): string {
  const cached = haystacks.get(entry);
  if (cached !== undefined) return cached;
  const data = stringifyLogData(entry.data);
  // Shaped like the rendered row minus its timestamp, so "[sdk]", "warn" and a
  // 0x hash pasted out of the payload all match what the eye actually sees.
  // The payload is in twice: as the JSON that copy and save produce, and as the
  // console-style text the row displays (`chainId: 1`, every property, one
  // line), so a query typed from either one finds the entry.
  // The timestamp is deliberately excluded: on screen it is local time
  // (formatDebugLogTime), which the UTC copy format does not agree with.
  // Built from that JSON rather than from entry.data, so the payload is walked
  // once per entry (a getter-backed SDK object is read once, not twice).
  const values = typeof entry.data === 'string' ? debugLogPayloadValues(entry) : parsedOrNone(data);
  const shown = values.length > 0
    ? expandedPayloadTokens(values).map((t) => t.text).join('').replace(/\n\s*/g, ' ')
    : '';
  const text = `${entry.level} [${entry.tag}] ${entry.message}${data ? ' ' + data : ''}${shown ? ' ' + shown : ''}`;
  const lower = text.toLowerCase();
  haystacks.set(entry, lower);
  return lower;
}

/** True when either control narrows the buffer, i.e. the badge reads "12 / 340". */
export function isDebugLogFilterActive(filter: DebugLogFilter): boolean {
  return (filter.level ?? 'all') !== 'all' || (filter.query ?? '').trim() !== '';
}

/**
 * Level chip AND search, in that order. Returns the input array itself when
 * neither narrows anything, so callers must treat the result as read-only.
 */
export function filterDebugLogs<T extends DebugLogEntry>(entries: T[], filter: DebugLogFilter): T[] {
  const level = filter.level ?? 'all';
  // Plain substring, never a RegExp: the whole point of this box is pasting an
  // address, a commitment or a 0x hash, and those would otherwise be read as a
  // pattern (a bare "(" would throw, "0x1.2" would match 0x142).
  const needle = (filter.query ?? '').trim().toLowerCase();
  if (level === 'all' && needle === '') return entries;

  const matched: T[] = [];
  for (const entry of entries) {
    // Level first: it is a field compare, and skipping here also spares the
    // haystack build for entries the chip has already ruled out.
    if (level !== 'all' && entry.level !== level) continue;
    if (needle !== '' && !debugLogHaystack(entry).includes(needle)) continue;
    matched.push(entry);
  }
  return matched;
}

/** "12 / 340" while a filter narrows the buffer, plain "340" otherwise. */
export function formatDebugLogCount(matching: number, total: number, filterActive: boolean): string {
  return filterActive ? `${matching} / ${total}` : `${total}`;
}

/**
 * Copy confirmation. It names the COUNT because `copy` takes the rows on
 * screen, not the whole buffer: right after a search, "12 logs copied" is the
 * only thing telling the user the clipboard holds the 12 and not the 2000.
 */
export function describeCopiedLogs(count: number): string {
  return `${count} log${count === 1 ? '' : 's'} copied`;
}

/**
 * Strip note-identifying hex from text bound for the debug buffer.
 *
 * The buffer is collected whether or not the debug overlay is on, and `copy`
 * exports it wholesale into bug reports users paste into chats and tickets. A
 * commitment or a nullifier identifies a note; several together reconstruct a
 * portfolio, which is the linkage this app exists to prevent. SDK errors name
 * the commitment they failed on, so error text is the usual way one escapes.
 *
 * A nullifier is the worse of the two. It is derived from the owner's key, and
 * for a note whose exit was only ever CLAIMED by the operator it has never
 * appeared on chain at all — so a log line is the only place it could exist
 * outside this device.
 *
 * 32 bytes or longer only: addresses (20) and selectors (4) survive, so a
 * redacted message is still diagnosable. Transaction hashes match and are
 * redacted too. They are public, but they are also the strongest link between a
 * device and a note, and no log line here needs one to be legible.
 */
export function redactNoteIdentifiers(text: string): string {
  return text.replace(/0x[0-9a-fA-F]{64,}/g, '0x<redacted>');
}
