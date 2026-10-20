// Network fixtures: record-once / replay-forever interception of every
// non-localhost request, so the live ASP feed (pool stats, activity, prices)
// and RPC reads can't drift between capture runs. See README.md.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type { BrowserContext, Route } from 'playwright';

export type FixtureMode = 'record' | 'replay' | 'live';

interface FixtureEntry {
  method: string;
  url: string;
  /** Normalized request body used for keying (JSON-RPC ids stripped). */
  requestBody?: string;
  status: number;
  contentType?: string;
  /** Response body, encoded per bodyEncoding (default 'base64'). */
  body: string;
  /** 'gzip-base64' when gzipping shrank the payload (large JSON bodies). */
  bodyEncoding?: 'base64' | 'gzip-base64';
}

export function encodeBody(buf: Buffer): Pick<FixtureEntry, 'body' | 'bodyEncoding'> {
  const gz = zlib.gzipSync(buf, { level: 9 });
  return gz.length < buf.length * 0.9
    ? { body: gz.toString('base64'), bodyEncoding: 'gzip-base64' }
    : { body: buf.toString('base64') };
}

export function decodeBody(entry: Pick<FixtureEntry, 'body' | 'bodyEncoding'>): Buffer {
  const raw = Buffer.from(entry.body, 'base64');
  return entry.bodyEncoding === 'gzip-base64' ? zlib.gunzipSync(raw) : raw;
}

/**
 * Normalize a request body for keying: JSON-RPC `id` fields are counters that
 * differ run to run, so they're zeroed (single requests and batch arrays).
 */
export function normalizeBody(body: string | null): string {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body) as unknown;
    const strip = (o: unknown): unknown => {
      if (Array.isArray(o)) return o.map(strip);
      if (o && typeof o === 'object' && 'jsonrpc' in (o as Record<string, unknown>)) {
        return { ...(o as Record<string, unknown>), id: 0 };
      }
      return o;
    };
    return JSON.stringify(strip(parsed));
  } catch {
    return body;
  }
}

/**
 * Rewrite JSON-RPC response ids to match the incoming request's ids.
 *
 * Batch alignment is POSITIONAL: the recorded request's raw ids were zeroed
 * by normalizeBody, so the response-element → request-element mapping is only
 * recoverable by index. That is correct for servers that answer batches
 * in-order (Alchemy/every node seen here); a server that reorders batch
 * responses would mis-pair results on replay. The recorded response array
 * order is whatever the server sent — with the raw request ids gone, nothing
 * better is possible without a fixture-format change.
 */
export function alignJsonRpcIds(storedBody: string, requestBody: string | null): string {
  if (!requestBody) return storedBody;
  try {
    const req = JSON.parse(requestBody) as unknown;
    const res = JSON.parse(storedBody) as unknown;
    if (Array.isArray(req) && Array.isArray(res)) {
      const ids = req.map((r) => (r && typeof r === 'object' ? (r as { id?: unknown }).id : undefined));
      const aligned = res.map((r, i) =>
        r && typeof r === 'object' && 'jsonrpc' in (r as Record<string, unknown>)
          ? { ...(r as Record<string, unknown>), id: ids[i] ?? 0 }
          : r,
      );
      return JSON.stringify(aligned);
    }
    if (
      req && typeof req === 'object' && 'jsonrpc' in (req as Record<string, unknown>) &&
      res && typeof res === 'object' && 'jsonrpc' in (res as Record<string, unknown>)
    ) {
      return JSON.stringify({ ...(res as Record<string, unknown>), id: (req as { id?: unknown }).id ?? 0 });
    }
    return storedBody;
  } catch {
    return storedBody;
  }
}

/**
 * Scrub secrets from DISPLAY fields before they hit disk (fixtures are
 * committed). Keys are hashed from the LIVE request URL, so scrubbing the
 * stored copy never affects replay matching.
 */
export function sanitizeForStorage(value: string): string {
  const alchemyKey = process.env.EXPO_PUBLIC_ALCHEMY_KEY;
  return alchemyKey && alchemyKey.length > 0
    ? value.split(alchemyKey).join('ALCHEMY_KEY_REDACTED')
    : value;
}

export function fixtureKey(method: string, url: string, body: string | null): string {
  const h = crypto.createHash('sha256');
  h.update(method);
  h.update('\n');
  h.update(url);
  h.update('\n');
  h.update(normalizeBody(body));
  return h.digest('hex').slice(0, 24);
}

/**
 * Content digest of a fixture set: sha256 over every entry file (sorted) plus
 * meta.json (the frozen replay clock changes rendering, so it is part of the
 * identity). index.json is derived and excluded. Baselines record the digest
 * they were captured against (baselines/manifest.json) and compare.ts FAILS
 * on a mismatch — the GATES-01 integrity mechanism: a fixture set and a
 * baseline set can never silently describe different data snapshots again.
 */
export function fixtureSetDigest(dir: string): string {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'index.json')
    .sort();
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(f);
    h.update('\n');
    h.update(fs.readFileSync(path.join(dir, f)));
    h.update('\n');
  }
  return h.digest('hex');
}

/** Recording goes to a STAGING directory, never the committed set. */
export const FIXTURE_STAGING_SUFFIX = '-staging';

/**
 * Open the right store for a mode: replay reads the committed set; record
 * writes into `<dir>-staging` (promote with scripts/visual/fixtures-promote.ts
 * after review). Duplicate-key overwrites with DIFFERENT content throw unless
 * PPV2_FIXTURES_ALLOW_OVERWRITE=1 — the exact failure that poisoned the F-A
 * fixture/baseline pairing (a later record session silently replaced shared
 * response keys under an unchanged meta.json timestamp).
 */
export function openFixtureStore(baseDir: string, mode: FixtureMode): FixtureStore {
  if (mode === 'record') {
    return new FixtureStore(baseDir + FIXTURE_STAGING_SUFFIX, {
      allowOverwrite: process.env.PPV2_FIXTURES_ALLOW_OVERWRITE === '1',
    });
  }
  return new FixtureStore(baseDir);
}

export class FixtureStore {
  private entries = new Map<string, FixtureEntry>();
  private dirty = false;
  readonly misses: { method: string; url: string }[] = [];
  private readonly allowOverwrite: boolean;
  /** Epoch ms of the recording session — replay freezes Date.now() to this. */
  recordedAt: number | null = null;

  constructor(readonly dir: string, opts: { allowOverwrite?: boolean } = {}) {
    this.allowOverwrite = opts.allowOverwrite === true;
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) {
      if (f === 'meta.json') {
        this.recordedAt = (JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { recordedAt: number }).recordedAt;
        continue;
      }
      if (!f.endsWith('.json') || f === 'index.json') continue;
      const entry = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as FixtureEntry;
      this.entries.set(f.replace(/\.json$/, ''), entry);
    }
  }

  /** Stamp the recording moment (kept stable across a session's re-runs). */
  stampRecordingTime(): void {
    if (this.recordedAt === null) {
      this.recordedAt = Date.now();
      fs.writeFileSync(path.join(this.dir, 'meta.json'), JSON.stringify({ recordedAt: this.recordedAt }, null, 1) + '\n');
    }
  }

  get size(): number {
    return this.entries.size;
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  get(key: string): FixtureEntry | undefined {
    return this.entries.get(key);
  }

  put(key: string, entry: FixtureEntry): void {
    const existing = this.entries.get(key);
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(entry)) return; // identical — nothing to do
      if (!this.allowOverwrite) {
        throw new Error(
          `fixture overwrite refused: key ${key} (${entry.method} ${entry.url}) already exists with different content. ` +
            `The upstream data changed between recording sessions — recapture the WHOLE set (fresh staging dir) or, ` +
            `if you consciously accept mixing snapshots, set PPV2_FIXTURES_ALLOW_OVERWRITE=1 and recapture every baseline afterwards ` +
            `(the baseline manifest digest will force that).`,
        );
      }
    }
    this.entries.set(key, entry);
    this.dirty = true;
    fs.writeFileSync(path.join(this.dir, `${key}.json`), JSON.stringify(entry, null, 1) + '\n');
  }

  /** Human-readable index for review/debugging. */
  writeIndex(): void {
    if (!this.dirty) return;
    const index = [...this.entries.entries()]
      .map(([key, e]) => ({ key, method: e.method, url: e.url, status: e.status, bytes: decodeBody(e).length }))
      .sort((a, b) => a.url.localeCompare(b.url) || a.key.localeCompare(b.key));
    fs.writeFileSync(path.join(this.dir, 'index.json'), JSON.stringify(index, null, 1) + '\n');
  }
}

function isLocal(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
}

/**
 * Install interception on a context.
 *  - record: pass through, saving every non-local response.
 *  - replay: serve recorded responses; unknown external requests are aborted
 *    (and counted in store.misses) so nothing live can leak into a capture.
 *  - live: no interception.
 */
export async function installFixtureRouting(
  context: BrowserContext,
  store: FixtureStore,
  mode: FixtureMode,
  log: (msg: string) => void = () => {},
): Promise<void> {
  if (mode === 'live') return;

  await context.route('**/*', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (isLocal(url)) {
      await route.fallback();
      return;
    }
    const body = request.postData();
    const key = fixtureKey(request.method(), request.url(), body);

    if (mode === 'record') {
      try {
        // Plain fetch, NOT route.fetch(): playwright-core 1.61's Set-Cookie
        // parsing crashes the process on some responses (invalid cookie
        // domain URL), and cookie propagation is irrelevant for fixtures.
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(request.headers())) {
          if (!['host', 'content-length', 'accept-encoding', 'connection'].includes(k.toLowerCase())) {
            headers[k] = v;
          }
        }
        const nodeRes = await fetch(request.url(), {
          method: request.method(),
          headers,
          body: body ?? undefined,
        });
        const buf = Buffer.from(await nodeRes.arrayBuffer());
        const contentType = nodeRes.headers.get('content-type') ?? undefined;
        store.put(key, {
          method: request.method(),
          url: sanitizeForStorage(request.url()),
          requestBody: sanitizeForStorage(normalizeBody(body)) || undefined,
          status: nodeRes.status,
          contentType,
          ...encodeBody(buf),
        });
        await route.fulfill({ status: nodeRes.status, contentType, body: buf });
      } catch (e) {
        log(`record: fetch failed ${request.method()} ${request.url()} — ${(e as Error).message}`);
        await route.abort('failed').catch(() => {});
      }
      return;
    }

    // replay
    const entry = store.get(key);
    if (!entry) {
      store.misses.push({ method: request.method(), url: request.url() });
      log(`replay MISS: ${request.method()} ${request.url()}`);
      await route.abort('failed').catch(() => {});
      return;
    }
    let responseBody: Buffer | string = decodeBody(entry);
    if (entry.contentType?.includes('json')) {
      responseBody = alignJsonRpcIds(responseBody.toString('utf8'), body);
    }
    await route.fulfill({
      status: entry.status,
      contentType: entry.contentType,
      body: responseBody,
    });
  });
}
