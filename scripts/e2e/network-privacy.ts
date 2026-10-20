/**
 * Observed-traffic checks for declared journey values. This is a bounded wire
 * decoder, NOT a proof of noninterference: unknown hashes, encryption, arbitrary
 * sharding and requests outside the recorded journey need separate coverage.
 */
import { brotliDecompressSync, gunzipSync, inflateSync, inflateRawSync } from 'node:zlib';

const MIN_SIGNIFICANT_DIGITS = 12;
const MAX_DECODE_BYTES = 8 * 1024 * 1024;
const MAX_DECODE_VIEWS = 4096;
const MAX_DECODE_DEPTH = 12;

export type CapturedRequest = {
  t: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  /** Lossless bytes for binary/compressed HTTP bodies and WebSocket frames. */
  bodyBase64?: string;
  /** An incomplete observation must fail the gate, not count as a clean request. */
  captureError?: string;
  kind: 'http' | 'websocket';
};

export type Destination = 'asp' | 'rpc' | 'relayer' | 'own-origin' | 'other';

/** Declare derived hashes in the corresponding bucket too; they cannot be inverted. */
export type JourneySecrets = {
  labels?: string[];
  labelHashes?: string[];
  commitments?: string[];
  nullifiers?: string[];
  /** Base units; low-entropy amounts are checked only in named amount/value fields.
   * Declare any displayed/token-unit representations separately. */
  amountsWei?: string[];
  /** Withdrawal recipient and connected wallet; only declare private journey values. */
  addresses?: string[];
};

/**
 * Default policy for withdrawal preparation, not all application actions.
 * Explicit self-report and transaction submission need their own scoped policy
 * in the journey. Do not weaken a whole destination to permit one operation.
 */
const FORBIDDEN_BY_DESTINATION: Record<Destination, (keyof JourneySecrets)[]> = {
  asp: ['labels', 'labelHashes', 'commitments', 'nullifiers', 'amountsWei', 'addresses'],
  rpc: ['labels', 'labelHashes', 'commitments', 'nullifiers', 'amountsWei'],
  relayer: ['labels', 'labelHashes', 'commitments'],
  'own-origin': [],
  // Unknown resources are fine unless they actually carry a declared value.
  other: ['labels', 'labelHashes', 'commitments', 'nullifiers', 'amountsWei', 'addresses'],
};

/** Common textual and byte encodings. Low-entropy numbers need scoped checks. */
export function encodingsOf(value: string, kind?: keyof JourneySecrets): string[] {
  const raw = value.trim();
  if (!raw) return [];
  const address = kind === 'addresses' && /^0x[\da-f]{40}$/i.test(raw);
  let number: bigint | undefined;
  if (/^(?:\d+|0x[\da-f]+)$/i.test(raw)) number = BigInt(raw);
  if (!address && (number === undefined ? raw.length : number.toString().length) < MIN_SIGNIFICANT_DIGITS) return [];

  const out = new Set<string>([raw]);
  if (number !== undefined) {
    const hex = number.toString(16);
    // Addresses are byte strings. Never hunt for their short numeric suffix.
    if (!address) {
      out.add(number.toString());
      out.add(`0x${hex}`);
      out.add(`0x${hex.toUpperCase()}`);
      out.add(hex.padStart(Math.ceil(hex.length / 2) * 2, '0'));
    }
    out.add(`0x${hex.padStart(64, '0')}`);
    out.add(hex.padStart(64, '0'));
    if (address) out.add(raw.slice(2));
  }
  for (const form of [...out]) {
    out.add(encodeURIComponent(form));
    out.add(Buffer.from(form).toString('base64'));
    out.add(Buffer.from(form).toString('base64url'));
    if (/^(?:0x)?[\da-f]+$/i.test(form) && form.replace(/^0x/i, '').length % 2 === 0) {
      const bytes = Buffer.from(form.replace(/^0x/i, ''), 'hex');
      out.add(bytes.toString('base64'));
      out.add(bytes.toString('base64url'));
    }
  }
  return [...out];
}

export type DestinationHosts = {
  /** Bare DNS names include subdomains; a URL is an exact origin (scheme + port). */
  asp: string[];
  rpc: string[];
  relayer: string[];
  /** Always exact host/origin; subdomains do not inherit this unconditional trust. */
  ownOrigin: string[];
};

export function classifyDestination(url: string, hosts: DestinationHosts): Destination {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return 'other'; }
  if (!['https:', 'http:', 'ws:', 'wss:'].includes(parsed.protocol)) return 'other';
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const matches = (entry: string, subdomains: boolean) => {
    const configured = entry.trim().toLowerCase();
    if (!configured) return false;
    if (configured.includes('://')) {
      try { return parsed.origin === new URL(configured).origin; } catch { return false; }
    }
    if (configured.includes(':')) return parsed.host.toLowerCase() === configured;
    const name = configured.replace(/\.$/, '');
    if (!subdomains) return hostname === name && !parsed.port;
    return hostname === name || hostname.endsWith(`.${name}`);
  };
  for (const destination of ['asp', 'relayer', 'rpc', 'own-origin'] as const) {
    const entries = destination === 'own-origin' ? hosts.ownOrigin : hosts[destination];
    if (entries.some((entry) => matches(entry, destination !== 'own-origin'))) return destination;
  }
  return 'other';
}

export type Leak = {
  destination: Destination;
  kind: keyof JourneySecrets;
  secret: string;
  encoding: string;
  where: 'url' | 'header' | 'body';
  detail: string;
  request: CapturedRequest;
};

function header(request: CapturedRequest, name: string): string {
  return Object.entries(request.headers).find(([key]) => key.toLowerCase() === name)?.[1] ?? '';
}

/** Never silently skip a compressed or missing body. Limits reject the observation. */
function bodyBytes(request: CapturedRequest): Buffer {
  let bytes: Buffer = request.bodyBase64 === undefined ? Buffer.from(request.body ?? '') : Buffer.from(request.bodyBase64, 'base64');
  const encodings = header(request, 'content-encoding').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
  for (const encoding of encodings.reverse()) {
    const opts = { maxOutputLength: MAX_DECODE_BYTES };
    if (encoding === 'gzip') bytes = gunzipSync(bytes, opts);
    else if (encoding === 'deflate') {
      try { bytes = inflateSync(bytes, opts); } catch { bytes = inflateRawSync(bytes, opts); }
    } else if (encoding === 'br') bytes = brotliDecompressSync(bytes, opts);
    else if (encoding !== 'identity') throw new Error(`Unsupported request content-encoding: ${encoding}`);
  }
  if (bytes.length > MAX_DECODE_BYTES) throw new Error('Network privacy body exceeds decode budget');
  return bytes;
}

/**
 * Decode envelopes, not just isolated secret encodings: b64(JSON(secret)) is
 * not b64(secret). Reassemble ordered parameter/JSON/multipart values within
 * one request; arbitrary reordering or splitting across requests is out of scope.
 */
function textViews(input: string): string[] {
  const views = new Set<string>();
  const queue: { text: string; depth: number }[] = [];
  let total = 0;
  const add = (text: string, depth: number) => {
    if (!text || views.has(text)) return;
    total += Buffer.byteLength(text);
    if (depth > MAX_DECODE_DEPTH || views.size >= MAX_DECODE_VIEWS || total > MAX_DECODE_BYTES) {
      throw new Error('Network privacy text exceeds decode budget');
    }
    views.add(text);
    queue.push({ text, depth });
  };
  add(input, 0);
  for (let i = 0; i < queue.length; i++) {
    const { text, depth } = queue[i]!;
    const next = (value: string) => add(value, depth + 1);
    // Decode percent escapes even if another part of a URL has a malformed %.
    next(text.replace(/(?:%[\da-f]{2})+/gi, (part) => {
      try { return decodeURIComponent(part); } catch { return part; }
    }));
    // Parse string tokens separately: preserves large JSON numbers and handles
    // escaped strings nested in strings without rounding through JS Number.
    for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
      let value: unknown;
      try { value = JSON.parse(match[0]); } catch { continue; }
      if (typeof value === 'string') next(value);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { /* Not a JSON document. */ }
    if (parsed !== undefined) {
      const values: string[] = [];
      const collect = (value: unknown) => {
        if (typeof value === 'string') values.push(value);
        else if (Array.isArray(value)) value.forEach(collect);
        else if (value && typeof value === 'object') Object.values(value).forEach(collect);
      };
      collect(parsed);
      if (values.length > 1) next(values.join(''));
    }
    const query = text.includes('?') ? text.slice(text.indexOf('?') + 1).split('#')[0]! : text;
    if (query.includes('=')) {
      const values = [...new URLSearchParams(query).values()];
      values.forEach(next);
      if (values.length > 1) next(values.join(''));
    }
    // Covers text fields and captured file bytes in multipart/form-data.
    const parts = [...text.matchAll(/\r\n\r\n([\s\S]*?)(?=\r\n--[^\r\n]+)/g)].map((m) => m[1]!);
    parts.forEach(next);
    if (parts.length > 1) next(parts.join(''));
    for (const match of text.matchAll(/[A-Za-z0-9+/_-]{12,}={0,2}/g)) {
      const token = match[0];
      if (token.length % 4 === 1 || /^[\da-f]+$/i.test(token)) continue;
      const decoded = Buffer.from(token, 'base64');
      if (decoded.toString('base64url') !== token.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')) continue;
      // Hex view detects b64 of raw ABI bytes; UTF-8 view decodes envelopes.
      next(decoded.toString('hex'));
      const utf8 = decoded.toString('utf8');
      if (Buffer.from(utf8).equals(decoded) && /^[\x20-\x7e\r\n\t]*$/.test(utf8)) next(utf8);
    }
  }
  return [...views];
}

function contains(view: string, encoding: string, decimal: boolean): boolean {
  // Decimal digits inside a longer hex word are not that decimal value.
  // Hex/ABI representations are checked separately through their own forms.
  if (decimal) return new RegExp(`(?<![0-9a-fx])${encoding}(?![0-9a-f])`, 'i').test(view);
  // Hex/address casing is immaterial (including EIP-55); base64 and arbitrary
  // strings are case-sensitive. Do not manufacture matches by folding them.
  if (/^(?:0x)?[\da-f]+$/i.test(encoding)) return view.toLowerCase().includes(encoding.toLowerCase());
  return view.includes(encoding);
}

export function findLeaks(requests: CapturedRequest[], secrets: JourneySecrets, hosts: DestinationHosts): Leak[] {
  const needles = Object.entries(secrets).flatMap(([kind, values]) =>
    [...new Set<string>(values ?? [])].map((secret) => {
      const forms = encodingsOf(secret, kind as keyof JourneySecrets);
      // Retained accounts contain dust. Short amounts cannot be identified in
      // arbitrary bytes (1 wei also matches RPC IDs), so check named amount/value
      // fields exactly. Distinctive amounts still get the full wire check.
      const scopedAmount = !forms.length && kind === 'amountsWei' && /^(?:\d+|0x[\da-f]+)$/i.test(secret);
      if (!forms.length && !scopedAmount) throw new Error(`No distinctive encoding for declared ${kind}; use a distinctive fixture or a scoped assertion`);
      return { kind: kind as keyof JourneySecrets, secret, forms, decimal: /^(?:\d+|0x[\da-f]+)$/i.test(secret) ? BigInt(secret).toString() : undefined };
    }),
  );
  const leaks: Leak[] = [];
  for (const request of requests) {
    if (request.captureError) throw new Error(`Incomplete network capture: ${request.captureError}`);
    const destination = classifyDestination(request.url, hosts);
    const forbidden = FORBIDDEN_BY_DESTINATION[destination];
    const bytes = bodyBytes(request);
    if (!forbidden.length) continue;
    // Fragments are never transmitted in an HTTP request.
    const sites: [Leak['where'], string[]][] = [
      ['url', textViews(request.url.split('#')[0]!)],
      ['header', Object.entries(request.headers).flatMap(([k, v]) => textViews(`${k}: ${v}`))],
      ['body', [...textViews(bytes.toString('utf8')), bytes.toString('hex')]],
    ];
    for (const { kind, secret, forms, decimal } of needles) {
      if (!forbidden.includes(kind)) continue;
      for (const [where, views] of sites) {
        const encoding = forms.length
          ? forms.find((form) => views.some((view) => contains(view, form, form === decimal)))
          : views.flatMap(view => [...view.matchAll(/(?:^|[\s{,&?])"?[\w-]*(?:amount|value)[\w-]*"?\s*[:=]\s*"?(0x[\da-f]+|\d+)(?=["\s,}&]|$)/gi)])
            .find(match => BigInt(match[1]!).toString() === decimal)?.[1];
        if (encoding) leaks.push({ destination, kind, secret, encoding, where, detail: `${request.method} ${request.url}`, request });
      }
    }
  }
  return leaks;
}

export function describeLeaks(leaks: Leak[]): string {
  return `${leaks.length} network-privacy violation(s):\n${leaks.map((l) =>
    `  ${l.destination.toUpperCase()} saw a ${l.kind} in the ${l.where}\n` +
    `    request : ${l.detail}\n    secret  : ${l.secret}\n    encoded : ${l.encoding}`,
  ).join('\n')}`;
}

/** RPC correlation IDs change on every poll; methods and parameters must not. */
export function pollBody(body: string | null): string | null {
  if (!body) return body;
  try {
    const parsed = JSON.parse(body);
    const calls = Array.isArray(parsed) ? parsed : [parsed];
    if (!calls.length || !calls.every(c => c?.jsonrpc === '2.0' && typeof c.method === 'string')) return body;
    const normalized = calls.map(({ id: _id, ...call }) => call);
    return JSON.stringify(Array.isArray(parsed) ? normalized : normalized[0]);
  } catch { return body; }
}

/** Exact request shapes with an explicit per-window budget, not URL substrings. */
export type PollBudget = {
  url: string;
  method: string;
  kind: CapturedRequest['kind'];
  body: string | null;
  maxRequests: number;
};
/** Legacy regex callers remain supported, but cannot constrain poll cadence. */
export type AlwaysOnPollMatcher = (PollBudget | RegExp)[];
export type TimingViolation = { detail: string; request: CapturedRequest };

/**
 * A window detects unexpected traffic, not causation. Derive poll budgets from
 * equal-duration idle controls; freeze poll timers/focus/retries in the browser
 * journey where possible, and repeat idle/action trials with identical setup.
 * Content checks must still run on all allowed polls. [start, end) avoids double
 * counting at adjacent phase boundaries. Debounced work needs a drain window.
 */
export function findTimingViolations(requests: CapturedRequest[], windowStart: number, windowEnd: number, allowed: AlwaysOnPollMatcher): TimingViolation[] {
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd <= windowStart) throw new Error('Invalid timing window');
  for (const poll of allowed) {
    if (poll instanceof RegExp) continue;
    if (!Number.isSafeInteger(poll.maxRequests) || poll.maxRequests < 0) throw new Error('Invalid poll budget');
  }
  const counts = new Map<string, number>();
  return requests.filter((r) => r.t >= windowStart && r.t < windowEnd).filter((r) => {
    if (r.captureError) throw new Error(`Incomplete network capture: ${r.captureError}`);
    const legacyAllowed = allowed.some((p) => p instanceof RegExp && new RegExp(p.source, p.flags.replace(/[gy]/g, '')).test(r.url));
    if (legacyAllowed) return false;
    const poll = allowed.find((p): p is PollBudget => !(p instanceof RegExp) && p.url === r.url && p.method === r.method && p.kind === r.kind && p.body === pollBody(r.body) && !r.bodyBase64);
    if (!poll) return true;
    const key = JSON.stringify([poll.url, poll.method, poll.kind, poll.body]);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return count > poll.maxRequests;
  }).map((request) => ({ detail: `${request.method} ${request.url}`, request }));
}
