/** Browser-side observation only: the node-side test wallet has its own transport. */
import { createWriteStream } from 'node:fs';
import type { CapturedRequest } from './network-privacy';

// Structural interfaces keep this module checked even with the repository's
// minimal ambient Playwright stub. No dependency on Playwright at test runtime.
interface RequestSource {
  method(): string;
  url(): string;
  headers(): Record<string, string>;
  allHeaders(): Promise<Record<string, string>>;
  postDataBuffer(): Buffer | null;
  resourceType(): string;
}
interface SocketSource {
  url(): string;
  on(event: 'framesent', handler: (frame: { payload: string | Buffer }) => void): void;
}
interface PageSource {
  on(event: 'websocket', handler: (socket: SocketSource) => void): void;
}
interface ProtocolRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}
interface SessionSource {
  send(method: string): Promise<unknown>;
  on(event: 'Network.requestWillBeSent', handler: (event: { type?: string; initiator?: { type?: string }; request: ProtocolRequest }) => void): void;
  on(event: 'Network.webSocketCreated', handler: (event: { requestId: string; url: string }) => void): void;
  on(event: 'Network.webSocketWillSendHandshakeRequest', handler: (event: { requestId: string; request: { headers: Record<string, string> } }) => void): void;
  on(event: 'Network.webSocketClosed', handler: (event: { requestId: string }) => void): void;
}
interface ContextSource {
  on(event: 'request', handler: (request: RequestSource) => void): void;
  on(event: 'page', handler: (page: PageSource) => void): void;
  on(event: 'close', handler: () => void): void;
  newCDPSession(page: PageSource): Promise<SessionSource>;
}

function setBytes(record: CapturedRequest, bytes: Buffer | null) {
  if (!bytes) return;
  const utf8 = bytes.toString('utf8');
  const compressed = Object.entries(record.headers).some(([key, value]) => key.toLowerCase() === 'content-encoding' && value !== 'identity');
  if (!compressed && Buffer.from(utf8).equals(bytes)) record.body = utf8;
  else record.bodyBase64 = bytes.toString('base64');
}

/**
 * Install before creating any pages, then await attachPage before navigating.
 * Service workers must be blocked by the context: their independent targets
 * are outside this CDP supplement. HTTP observation does not route/alter CORS.
 * Await flushCapture before every assertion and before closing the browser.
 */
/**
 * The dev server's own HMR socket (Metro's /hot, and only that path). In development the app forwards
 * every console line over it, pretty-printed: one "Account exported" line on
 * the shared test account (1000+ notes) is hundreds of KB, so a few syncs
 * filled the 64MB budget and failed the phase ("Network capture retention
 * budget exceeded", runs 37767164114, 37725929454). The frames are still
 * recorded, with timestamp and URL, so they stay visible to every timing
 * check; only their payload is not kept. Nothing is lost to the content
 * checks: the socket is own-origin, for which the gate forbids no value
 * (FORBIDDEN_BY_DESTINATION in network-privacy.ts), and it does not exist in
 * a production build.
 */
function isDevServerSocket(url: string, devServerOrigin: string | undefined): boolean {
  if (!devServerOrigin) return false;
  try {
    const want = new URL(devServerOrigin);
    const got = new URL(url);
    // Metro's own socket only: same host, the scheme that matches the page
    // (http -> ws, https -> wss), and the /hot path.
    const scheme = want.protocol === 'https:' ? 'wss:' : want.protocol === 'http:' ? 'ws:' : null;
    return got.host === want.host && got.protocol === scheme && got.pathname === '/hot';
  } catch {
    return false;
  }
}

export function startNetworkCapture(context: ContextSource, options: { enabled?: boolean; file?: string; maxBytes?: number; flushTimeoutMs?: number; devServerOrigin?: string } = {}) {
  const captured: CapturedRequest[] = [];
  /** Retained bytes per destination, so an overflow names what filled it. */
  const bytesBy = new Map<string, number>();
  const pending = new Set<Promise<void>>();
  const attached = new WeakMap<PageSource, Promise<void>>();
  const sink = options.file ? createWriteStream(options.file, { flags: 'a', mode: 0o600, highWaterMark: 1024 * 1024 }) : undefined;
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  let enabled = options.enabled ?? true;
  let retainedBytes = 0;
  let error: Error | undefined;
  let closed = false;
  sink?.on('error', (cause) => { error = cause; });
  const fail = (message: string) => { error ??= new Error(message); };
  const save = (record: CapturedRequest) => {
    if (error) return;
    const line = JSON.stringify(record) + '\n';
    const size = Buffer.byteLength(line);
    retainedBytes += size;
    let where = record.url;
    try { const u = new URL(record.url); where = `${record.kind} ${u.origin}${u.pathname}`; } catch { /* keep the raw URL */ }
    bytesBy.set(where, (bytesBy.get(where) ?? 0) + size);
    if (retainedBytes > maxBytes) {
      const top = [...bytesBy].sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([key, n]) => `${key} ${(n / 1024 / 1024).toFixed(1)}MB`).join(', ');
      record.captureError = `Network capture retention budget exceeded; assert and clear between phases (largest: ${top})`;
      fail(record.captureError);
    } else if (sink) {
      sink.write(line);
      if (sink.writableLength <= 8 * 1024 * 1024) return;
      // Do not block the event loop or accumulate an unlimited write queue.
      record.captureError = 'Network capture file sink backpressure exceeded';
      fail(record.captureError);
    }
  };
  const track = (task: Promise<void>) => {
    const handled = task.catch((cause: unknown) => { fail(String(cause)); }).finally(() => pending.delete(handled));
    pending.add(handled);
  };
  context.on('request', (request) => {
    // Chromium preflights can lack a frame and be absent from this event. They
    // are captured by CDP below, without the CORS-changing effects of routing.
    if (request.resourceType() === 'preflight') return;
    if (!enabled || error) return;
    if (pending.size >= 1024) {
      fail('Too many pending network observations');
      captured.push({ t: Date.now(), method: request.method(), url: request.url(), headers: {}, body: null, kind: 'http', captureError: 'Pending capture budget exceeded' });
      return;
    }
    const record: CapturedRequest = {
      t: Date.now(), method: request.method(), url: request.url(),
      headers: request.headers(), body: null, kind: 'http',
      captureError: 'Request headers/body capture pending; await flushCapture()',
    };
    captured.push(record); // Timestamp/order assigned synchronously, before awaits.
    const bytes = request.postDataBuffer();
    track((async () => {
      record.headers = await request.allHeaders();
      setBytes(record, bytes);
      const length = Object.entries(record.headers).find(([key]) => key.toLowerCase() === 'content-length')?.[1];
      // Chromium omits file-backed multipart entries and streaming upload data.
      // postDataBuffer preserves available bytes but cannot recover missing ones.
      if (length !== undefined && Number(length) !== (bytes?.length ?? 0)) {
        record.captureError = 'Request body bytes missing or truncated';
      } else if (!bytes && !['GET', 'HEAD'].includes(record.method) && length !== '0') {
        record.captureError = 'Request body unavailable (possibly streaming or file-backed)';
      } else {
        delete record.captureError;
      }
      save(record);
    })());
  });

  const attachPage = (page: PageSource): Promise<void> => {
    const existing = attached.get(page);
    if (existing) return existing;
    const handshakes = new Map<string, CapturedRequest[]>();
    const headersByUrl = new Map<string, Record<string, string>[]>();
    page.on('websocket', (socket) => {
      if (error) return;
      if (enabled) {
        const record: CapturedRequest = {
          t: Date.now(), method: 'GET', url: socket.url(), headers: {}, body: null, kind: 'websocket',
          captureError: 'WebSocket handshake headers unavailable; target may not be observed',
        };
        captured.push(record); // A URL/subprotocol/cookie can leak with NO frames.
        const headers = headersByUrl.get(socket.url())?.shift();
        if (!headersByUrl.get(socket.url())?.length) headersByUrl.delete(socket.url());
        if (headers) {
          record.headers = headers;
          delete record.captureError;
          save(record);
        } else {
          const queue = handshakes.get(socket.url()) ?? [];
          queue.push(record);
          handshakes.set(socket.url(), queue);
        }
      }
      socket.on('framesent', ({ payload }) => {
        if (!enabled || error) return;
        const frame: CapturedRequest = { t: Date.now(), method: 'WS', url: socket.url(), headers: {}, body: null, kind: 'websocket' };
        if (!isDevServerSocket(frame.url, options.devServerOrigin)) {
          setBytes(frame, typeof payload === 'string' ? Buffer.from(payload) : payload);
        }
        captured.push(frame);
        save(frame);
      });
    });
    const setup = (async () => {
      const session = await context.newCDPSession(page);
      const urls = new Map<string, string>();
      session.on('Network.requestWillBeSent', ({ type, initiator, request }) => {
        if ((type !== 'Preflight' && initiator?.type !== 'preflight') || !enabled || error) return;
        const record: CapturedRequest = { t: Date.now(), method: request.method, url: request.url, headers: request.headers, body: null, kind: 'http' };
        captured.push(record);
        save(record);
      });
      session.on('Network.webSocketCreated', ({ requestId, url }) => { urls.set(requestId, url); });
      session.on('Network.webSocketWillSendHandshakeRequest', ({ requestId, request }) => {
        const url = urls.get(requestId);
        if (!url || !enabled || error) return;
        const record = handshakes.get(url)?.shift();
        if (record) {
          record.headers = request.headers;
          delete record.captureError;
          save(record);
          if (!handshakes.get(url)?.length) handshakes.delete(url);
        } else {
          const queue = headersByUrl.get(url) ?? [];
          queue.push(request.headers);
          headersByUrl.set(url, queue);
        }
      });
      session.on('Network.webSocketClosed', ({ requestId }) => { urls.delete(requestId); });
      await session.send('Network.enable');
    })();
    attached.set(page, setup);
    track(setup);
    return setup;
  };
  context.on('page', (page) => { void attachPage(page); });
  context.on('close', () => { closed = true; sink?.end(); });

  const flushCapture = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          if (error) throw error;
          while (pending.size) await Promise.all([...pending]);
          if (error) throw error;
          const incomplete = captured.find((request) => request.captureError);
          if (incomplete) throw new Error(`Incomplete network capture: ${incomplete.captureError}`);
          if (sink && !closed) await new Promise<void>((resolve, reject) => sink.write('', (cause) => cause ? reject(cause) : resolve()));
        })(),
        new Promise<never>((_, reject) => {
          // Playwright resolves allHeaders after the response. Allow the app's
          // 30-second HTTP timeout to settle without dropping request headers.
          // 90s, not 45s: slow Alchemy/Citrea RPC answers outlived 45s and
          // failed the capture (e2e runs 38251768622, 38253851048).
          timer = setTimeout(() => {
            const incomplete = captured.filter(r => r.captureError).slice(0, 5).map(r => `${r.method} ${new URL(r.url).origin}`);
            fail(`Network capture flush timed out (${incomplete.join(', ') || 'pending setup'})`);
            reject(error);
          }, options.flushTimeoutMs ?? 90_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const clearCapture = () => {
    if (pending.size || captured.some((request) => request.captureError)) throw new Error('Flush and assert capture before clearing it');
    if (error) throw error;
    captured.length = 0;
    retainedBytes = 0;
    bytesBy.clear();
  };
  return { captured, attachPage, flushCapture, clearCapture,
    startCapture: async () => { await flushCapture(); clearCapture(); enabled = true; },
    stopCapture: async () => { enabled = false; await flushCapture(); },
  };
}
