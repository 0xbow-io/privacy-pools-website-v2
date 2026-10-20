import { Buffer } from 'node:buffer';
import { serve } from 'bun';
// Local browser regression; no application, wallet, chain or external API needed.
// Run: safewrap bun scripts/e2e/network-capture-smoke.mjs
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { startNetworkCapture } from './network-capture.ts';
import { findLeaks } from './network-privacy.ts';

const LABEL = '12345678901234567890123456789012345678901234567890';
const observed = [];
const server = serve({
  port: 0,
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === '/ws' && server.upgrade(request)) return;
    observed.push({ url: request.url, method: request.method, body: await request.text() });
    if (url.pathname === '/redirect') return Response.redirect(`${server.url}redirected?label=${LABEL}`, 302);
    if (request.method === 'OPTIONS') return new Response('', { status: 403 });
    return new Response('<html><body>capture smoke</body></html>', { headers: { 'content-type': 'text/html' } });
  },
  websocket: { message() {} },
});
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.PW_EXECUTABLE_PATH ? { executablePath: process.env.PW_EXECUTABLE_PATH } : {}) });
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const capture = startNetworkCapture(context);
  const page = await context.newPage();
  await capture.attachPage(page);
  await page.goto(String(server.url));
  await page.evaluate(async ({ label, compressed, port }) => {
    document.cookie = `label=${label}`;
    await fetch(`/header`, { headers: { 'X-Labels': label } });
    await fetch('/gzip', { method: 'POST', headers: { 'Content-Encoding': 'gzip' }, body: Uint8Array.from(compressed) });
    const form = new FormData();
    form.append('label', label);
    await fetch('/multipart', { method: 'POST', body: form });
    await fetch('/redirect');
    // Failed preflight still exposes URL and custom header NAMES to the server.
    await fetch(`http://127.0.0.1:${port}/cors?label=${label}`, { headers: { 'X-Test': label } }).catch(() => {});
    navigator.sendBeacon('/beacon', label);
    await new Promise((resolve, reject) => {
      const source = `fetch(${JSON.stringify(`${location.origin}/worker?label=${label}`)}).then(() => postMessage('done'));`;
      const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      const worker = new Worker(blobUrl);
      worker.onmessage = () => { worker.terminate(); URL.revokeObjectURL(blobUrl); resolve(); };
      worker.onerror = reject;
    });
    await new Promise((resolve) => {
      const ws = new WebSocket(`${location.origin.replace('http:', 'ws:')}/ws?label=${label}`, label);
      ws.onopen = () => { ws.send(label); ws.send(new TextEncoder().encode(label)); ws.close(); resolve(); };
    });
  }, { label: LABEL, compressed: [...gzipSync(Buffer.from(LABEL))], port: server.port });
  await page.waitForTimeout(100);
  await capture.flushCapture();
  const requests = capture.captured;
  assert.equal(requests[0].url, String(server.url), 'first navigation captured');
  assert(requests.some((r) => r.url.endsWith('/header') && r.headers.cookie?.includes(LABEL)), 'cookie captured');
  assert(requests.some((r) => r.url.includes('/cors?') && r.method === 'OPTIONS'), 'denied preflight captured');
  assert(requests.some((r) => r.url.includes('/redirected?')), 'redirect captured');
  assert(requests.some((r) => r.url.endsWith('/beacon') && r.body === LABEL), 'beacon captured');
  assert.equal(requests.filter((r) => r.method === 'WS').length, 2, 'first text and binary websocket frames captured');
  assert(requests.some((r) => r.kind === 'websocket' && Object.entries(r.headers).some(([k, v]) => k.toLowerCase() === 'sec-websocket-protocol' && v === LABEL)), 'websocket handshake captured');
  const hosts = { asp: [server.url.host, `127.0.0.1:${server.port}`], rpc: [], relayer: [], ownOrigin: [] };
  const leaks = findLeaks(requests, { labels: [LABEL] }, hosts);
  for (const path of ['/header', '/gzip', '/multipart', '/redirected?', '/beacon', '/worker?', '/cors?', '/ws?']) {
    assert(leaks.some((leak) => leak.request.url.includes(path)), `${path} detected from observed browser traffic`);
  }
  capture.clearCapture();
  assert.equal(requests.length, 0, 'phase capture released');

  // File-backed multipart is partially omitted by CDP: reject the observation.
  await page.setContent('<input type="file" />');
  await page.locator('input').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from(LABEL) });
  await page.evaluate(async () => {
    const form = new FormData();
    form.append('file', document.querySelector('input').files[0]);
    await fetch('/file', { method: 'POST', body: form });
  });
  await page.waitForTimeout(50);
  // Browser versions may expose all bytes or omit file entries. Either a
  // detected leak or an explicit incomplete-capture failure is acceptable.
  try {
    await capture.flushCapture();
    assert(findLeaks(capture.captured, { labels: [LABEL] }, hosts).some((leak) => leak.where === 'body'), 'file leak detected');
    console.log('File upload: bytes captured and leak detected');
  } catch (error) {
    assert.match(String(error), /Incomplete network capture.*body bytes missing/);
    console.log('File upload: browser omitted bytes; capture rejected explicitly');
  }
  await context.close();
  console.log(`PASS browser capture smoke: ${observed.length} server requests; navigation, cookies, gzip, multipart/file, redirect, denied preflight, beacon, dedicated worker HTTP, websocket handshake/first frames, phase cleanup`);
} finally {
  await browser.close();
  server.stop(true);
}
