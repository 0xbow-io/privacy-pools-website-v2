import { toFunctionSelector } from 'viem';
import { pollBody } from './network-privacy.ts';

// Keep external pool events and approvals constant across the timing controls
// and action. Replay observed public inputs; still check every outgoing request.
export function recordPublicState(page, aspUrl) {
  const origin = new URL(aspUrl).origin;
  const rootSelector = toFunctionSelector('latestASPRoot()');
  const publicAsp = url => url.origin === origin && (
    /^\/\d+\/public\/event-snapshot\/(latest|payload)$/.test(url.pathname)
    || /^\/association-set\/(root|leaves)$/.test(url.pathname)
    || /^\/labels\/(rejected|poi-required)$/.test(url.pathname)
  );
  const rootCall = request => {
    try {
      const call = JSON.parse(request.postData() ?? 'null');
      return call?.method === 'eth_call' && call.params?.[0]?.data === rootSelector ? call : null;
    } catch { return null; }
  };
  const keyOf = request => request.method() === 'GET' && publicAsp(new URL(request.url()))
    ? request.url() : rootCall(request) ? `${request.url()} ${pollBody(request.postData())}` : null;
  const responses = new Map();
  const urls = new Set();
  const pending = new Set();
  let failure;
  const observe = response => {
    const key = keyOf(response.request());
    if (!key || !response.ok()) return;
    const task = (async () => {
      const body = await response.body();
      if (rootCall(response.request()) && !('result' in JSON.parse(body.toString()))) return;
      const headers = await response.allHeaders();
      // Playwright returns decoded bytes; fulfill computes their wire length.
      delete headers['content-encoding'];
      delete headers['content-length'];
      responses.set(key, { status: response.status(), headers, body });
      urls.add(response.url());
    })().catch(error => { failure = error; }).finally(() => pending.delete(task));
    pending.add(task);
  };
  page.on('response', observe);
  return async () => {
    page.off('response', observe);
    await Promise.all(pending);
    if (failure) throw failure;
    if (![...urls].some(url => new URL(url).pathname.endsWith('/event-snapshot/payload'))) {
      throw new Error('Privacy timing needs an observed public event snapshot');
    }
    const matches = url => urls.has(url.href);
    const replay = route => {
      const request = route.request();
      const response = responses.get(keyOf(request));
      if (!response) return route.fallback();
      const call = rootCall(request);
      // RPC IDs correlate responses, and must follow the current request.
      const body = call ? JSON.stringify({ ...JSON.parse(response.body.toString()), id: call.id }) : response.body;
      return route.fulfill({ ...response, body });
    };
    await page.route(matches, replay);
    return () => page.unroute(matches, replay);
  };
}
