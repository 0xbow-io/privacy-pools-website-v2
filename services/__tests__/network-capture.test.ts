import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { startNetworkCapture } from '../../scripts/e2e/network-capture';
import { findLeaks } from '../../scripts/e2e/network-privacy';

const LABEL = '12345678901234567890123456789012345678901234567890';
const HOSTS = { asp: ['api.0xbow.io'], rpc: [], relayer: [], ownOrigin: [] };
class Context extends EventEmitter {
  session = Object.assign(new EventEmitter(), { send: async () => {} });
  async newCDPSession() { return this.session; }
}
function request(overrides = {}) {
  return {
    method: () => 'POST', url: () => 'https://api.0xbow.io/x', resourceType: () => 'fetch',
    headers: () => ({}), allHeaders: async () => ({}), postDataBuffer: () => Buffer.from(LABEL),
    ...overrides,
  };
}

describe('network capture lifecycle', () => {
  test('records request order synchronously, awaits all headers, then releases a phase', async () => {
    const context = new Context();
    const capture = startNetworkCapture(context);
    let resolve!: (headers: Record<string, string>) => void;
    context.emit('request', request({ allHeaders: () => new Promise((r) => { resolve = r; }) }));
    context.emit('request', request({ url: () => 'https://api.0xbow.io/second' }));
    expect(capture.captured.map((r) => r.url)).toEqual(['https://api.0xbow.io/x', 'https://api.0xbow.io/second']);
    expect(() => findLeaks(capture.captured, { labels: [LABEL] }, HOSTS)).toThrow('Incomplete');
    expect(() => capture.clearCapture()).toThrow('Flush');
    resolve({ cookie: LABEL });
    await capture.flushCapture();
    expect(findLeaks(capture.captured, { labels: [LABEL] }, HOSTS).map((r) => r.where)).toEqual(['header', 'body', 'body']);
    capture.clearCapture();
    expect(capture.captured).toHaveLength(0);
    context.emit('close');
  });
  test('retains binary bytes losslessly', async () => {
    const context = new Context();
    const capture = startNetworkCapture(context);
    const bytes = Buffer.from([255, 254, 0, 128, 129]);
    context.emit('request', request({ postDataBuffer: () => bytes }));
    await capture.flushCapture();
    expect(capture.captured[0].body).toBeNull();
    expect(capture.captured[0].bodyBase64).toBe(bytes.toString('base64'));
    context.emit('close');
  });
  test('missing/truncated upload bytes fail instead of passing a clean observation', async () => {
    for (const bytes of [null, Buffer.from('partial')]) {
      const context = new Context();
      const capture = startNetworkCapture(context);
      context.emit('request', request({ postDataBuffer: () => bytes, allHeaders: async () => ({ 'content-length': '200' }) }));
      await expect(capture.flushCapture()).rejects.toThrow('body bytes missing');
      expect(() => findLeaks(capture.captured, {}, HOSTS)).toThrow('Incomplete');
      context.emit('close');
    }
  });
  test('distinguishes an empty POST from an unavailable upload', async () => {
    const context = new Context();
    const capture = startNetworkCapture(context);
    context.emit('request', request({ postDataBuffer: () => null, allHeaders: async () => ({ 'content-length': '0' }) }));
    await capture.flushCapture();
    context.emit('request', request({ postDataBuffer: () => null }));
    await expect(capture.flushCapture()).rejects.toThrow('body unavailable');
    context.emit('close');
  });
  test('header failure and retention overflow are fatal and bounded', async () => {
    const context = new Context();
    const capture = startNetworkCapture(context, { maxBytes: 100 });
    context.emit('request', request());
    await expect(capture.flushCapture()).rejects.toThrow('retention budget');
    const count = capture.captured.length;
    for (let i = 0; i < 100; i++) context.emit('request', request());
    expect(capture.captured).toHaveLength(count);
    context.emit('close');
    const other = new Context();
    const failed = startNetworkCapture(other);
    other.emit('request', request({ allHeaders: async () => { throw new Error('target closed'); } }));
    await expect(failed.flushCapture()).rejects.toThrow('target closed');
    other.emit('close');
  });
  test('records frame-less websocket handshakes and immediate binary frames', async () => {
    const context = new Context();
    const capture = startNetworkCapture(context);
    const page = new EventEmitter();
    context.emit('page', page);
    await capture.attachPage(page);
    const socket = Object.assign(new EventEmitter(), { url: () => 'wss://api.0xbow.io/ws' });
    page.emit('websocket', socket);
    socket.emit('framesent', { payload: Buffer.from([255, 254]) });
    context.session.emit('Network.webSocketCreated', { requestId: '1', url: socket.url() });
    context.session.emit('Network.webSocketWillSendHandshakeRequest', { requestId: '1', request: { headers: { 'Sec-WebSocket-Protocol': LABEL } } });
    await capture.flushCapture();
    expect(capture.captured).toHaveLength(2);
    expect(capture.captured[1].bodyBase64).toBe('//4=');
    expect(findLeaks(capture.captured, { labels: [LABEL] }, HOSTS)[0].where).toBe('header');
    context.emit('close');
  });
  test('keeps the dev server socket frames but not their payload, and only for that host', async () => {
    const context = new Context();
    const capture = startNetworkCapture(context, { devServerOrigin: 'http://localhost:8081', maxBytes: 4096 });
    const page = new EventEmitter();
    await capture.attachPage(page);
    const metro = Object.assign(new EventEmitter(), { url: () => 'ws://localhost:8081/hot?platform=web' });
    const other = Object.assign(new EventEmitter(), { url: () => 'wss://api.0xbow.io/ws' });
    // Same host, any other path: an app socket, not Metro's, so it is kept.
    const sameHost = Object.assign(new EventEmitter(), { url: () => 'ws://localhost:8081/app' });
    // The page is http, so a wss socket on /hot is not Metro's.
    const otherScheme = Object.assign(new EventEmitter(), { url: () => 'wss://localhost:8081/hot' });
    for (const [id, socket] of [['1', metro], ['2', other], ['3', sameHost], ['4', otherScheme]] as const) {
      page.emit('websocket', socket);
      context.session.emit('Network.webSocketCreated', { requestId: id, url: socket.url() });
      context.session.emit('Network.webSocketWillSendHandshakeRequest', { requestId: id, request: { headers: {} } });
    }
    // A console line far over the budget: recorded, payload not retained.
    metro.emit('framesent', { payload: 'x'.repeat(64 * 1024) });
    other.emit('framesent', { payload: LABEL });
    sameHost.emit('framesent', { payload: 'kept' });
    otherScheme.emit('framesent', { payload: 'kept too' });
    await capture.flushCapture();
    const frames = capture.captured.filter((r) => r.method === 'WS');
    expect(frames.map((r) => r.url)).toEqual([metro.url(), other.url(), sameHost.url(), otherScheme.url()]);
    expect(frames[0].body).toBeNull();
    expect(frames[0].bodyBase64).toBeUndefined();
    expect(frames[1].body).toBe(LABEL);
    expect(frames[2].body).toBe('kept');
    expect(frames[3].body).toBe('kept too');
    expect(findLeaks(capture.captured, { labels: [LABEL] }, HOSTS)[0].where).toBe('body');
    context.emit('close');
  });
  test('an overflow names the destination that filled the budget', async () => {
    const context = new Context();
    const capture = startNetworkCapture(context, { maxBytes: 100 });
    context.emit('request', request());
    await expect(capture.flushCapture()).rejects.toThrow('largest: http https://api.0xbow.io/x');
    context.emit('close');
  });
  test('fails when a socket target has no handshake observation', async () => {
    const context = new Context();
    const capture = startNetworkCapture(context);
    const page = new EventEmitter();
    await capture.attachPage(page);
    page.emit('websocket', Object.assign(new EventEmitter(), { url: () => 'wss://api.0xbow.io/ws' }));
    await expect(capture.flushCapture()).rejects.toThrow('WebSocket handshake headers unavailable');
    context.emit('close');
  });
  test('captures a frame-less preflight identified by its initiator', async () => {
    const context = new Context();
    const capture = startNetworkCapture(context);
    await capture.attachPage(new EventEmitter());
    context.session.emit('Network.requestWillBeSent', { type: 'Other', initiator: { type: 'preflight' }, request: { url: `https://api.0xbow.io/${LABEL}`, method: 'OPTIONS', headers: {} } });
    await capture.flushCapture();
    expect(capture.captured[0].method).toBe('OPTIONS');
    expect(findLeaks(capture.captured, { labels: [LABEL] }, HOSTS)).toHaveLength(1);
    context.emit('close');
  });
});


test('unavailable headers cannot hang a privacy assertion indefinitely', async () => {
  const context = new Context();
  const capture = startNetworkCapture(context, { flushTimeoutMs: 10 });
  context.emit('request', request({ allHeaders: () => new Promise(() => {}) }));
  await expect(capture.flushCapture()).rejects.toThrow('flush timed out');
  expect(() => findLeaks(capture.captured, {}, HOSTS)).toThrow('Incomplete');
  context.emit('close');
});

test('bounded windows retain pending requests and observe frames on pre-existing sockets', async () => {
  const context = new Context();
  const capture = startNetworkCapture(context, { enabled: false });
  const page = new EventEmitter();
  await capture.attachPage(page);
  const socket = Object.assign(new EventEmitter(), { url: () => 'wss://api.0xbow.io/ws' });
  page.emit('websocket', socket);
  context.emit('request', request());
  expect(capture.captured).toHaveLength(0);
  await capture.startCapture();
  let resolve!: (headers: Record<string, string>) => void;
  context.emit('request', request({ allHeaders: () => new Promise(r => { resolve = r; }) }));
  socket.emit('framesent', { payload: LABEL });
  const stopped = capture.stopCapture();
  resolve({});
  await stopped;
  expect(findLeaks(capture.captured, { labels: [LABEL] }, HOSTS)).toHaveLength(2);
  socket.emit('framesent', { payload: LABEL });
  expect(capture.captured).toHaveLength(2);
  capture.clearCapture();
  expect(capture.captured).toHaveLength(0);
  context.emit('close');
});
