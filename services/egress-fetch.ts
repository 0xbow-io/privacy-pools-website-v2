import { throwIfAborted } from '@/services/abort-signal';
import { assertEgressAllowed, EgressRefusedError, type EgressIntent, type EgressParty } from '@/services/egress-policy';
import { AspBackoffError, createAspBackoff, createAspPacer, responseIsRateLimit, type AspProbe } from '@/services/asp-backoff';
import { torFetchFor } from '@/services/tor-fetch';

/** Match URL origins and path boundaries, never string prefixes of hostnames. */
export function configuredEgressPath(party: EgressParty, baseUrl: string, url: string): string {
  try {
    const base = new URL(baseUrl);
    const target = new URL(url);
    const prefix = base.pathname.replace(/\/+$/, '');
    if (!['http:', 'https:'].includes(target.protocol) || target.origin !== base.origin
      || target.username || target.password || target.hash || base.search || base.hash
      || (prefix && target.pathname !== prefix && !target.pathname.startsWith(`${prefix}/`))) {
      throw new Error('outside configured endpoint');
    }
    return `${target.pathname.slice(prefix.length) || '/'}${target.search}`;
  } catch {
    throw new EgressRefusedError(party, 'request is outside the configured endpoint');
  }
}

/** The same transport is used in production and tests; clocks can be injected. */
export function createEgressFetch(
  backoff = createAspBackoff(),
  pacer = createAspPacer(),
) {
  let stopped = false;
  let generation = 0;
  let probeAbort: AbortController | undefined;
  backoff.onWindowStart(() => pacer.cancelPending(new AspBackoffError(backoff.blockedForMs())));

  async function send(
    party: 'asp' | 'relayer',
    baseUrl: string,
    url: string,
    init: RequestInit = {},
    intent?: EgressIntent,
    probe?: AspProbe,
  ): Promise<Response> {
    const path = configuredEgressPath(party, baseUrl, url);
    const headers = new Headers(init.headers);
    if (init.body != null && typeof init.body !== 'string') {
      throw new EgressRefusedError(party, 'request body must be inspectable JSON text');
    }
    assertEgressAllowed(party, {
      method: init.method ?? 'GET',
      url: path,
      headers: Object.fromEntries(headers.entries()),
      body: init.body,
    }, intent);
    const requestGeneration = generation;
    if (party === 'asp') {
      if (stopped) throw new Error('ASP feeds stopped');
      if (!probe) backoff.assertOpen();
    }
    let sentAt = 0;
    // Over anon-rpc when Tor is in force, on the worker of the group this
    // request belongs to: an account it names, the operation in progress for
    // relayer calls and targeted ASP queries, or the public one
    // (services/tor-groups.ts). Chosen now, when the request is made: the ASP
    // pacer may send it after the operation that made it has ended.
    const send = torFetchFor(party, `${url}\n${typeof init.body === 'string' ? init.body : ''}`, {
      identifying: intent !== undefined,
    }) ?? fetch;
    const dispatch = () => {
      if (party === 'asp') {
        if (stopped || generation !== requestGeneration) throw new Error('ASP feeds stopped');
        if (probe) {
          if (!backoff.isCurrentProbe(probe)) throw new Error('ASP probe window ended');
        } else backoff.assertOpen();
      }
      throwIfAborted(init.signal);
      sentAt = backoff.now();
      // Redirects would send another request without consulting the policy.
      // These APIs use neither cookies nor the page URL as authentication.
      return send(url, { ...init, headers, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' });
    };
    // Policy first, backoff before queueing, and again at the actual send.
    const response = await (party === 'asp' ? pacer.run(dispatch, init.signal) : dispatch());
    if (party === 'asp' && !probe) {
      if (await responseIsRateLimit(response)) backoff.recordRateLimited(sentAt);
      else if (response.ok) backoff.recordSuccess(sentAt);
    }
    return response;
  }

  return {
    policedFetch: (party: 'asp' | 'relayer', baseUrl: string, url: string, init?: RequestInit, intent?: EgressIntent) =>
      send(party, baseUrl, url, init, intent),
    /** Only the public grid calls this. The URL and cadence are user-independent. */
    async probeAsp(baseUrl: string): Promise<void> {
      const ticket = backoff.beginProbe();
      if (!ticket) return;
      const abort = new AbortController();
      probeAbort = abort;
      const timer = setTimeout(() => abort.abort(), 10_000);
      let success = false;
      try {
        const response = await send('asp', baseUrl, `${baseUrl.replace(/\/$/, '')}/public-key`, { signal: abort.signal }, undefined, ticket);
        // Drain the small body, with the same timeout as the connection.
        await response.text();
        success = response.ok && !abort.signal.aborted;
      } finally {
        clearTimeout(timer);
        if (probeAbort === abort) probeAbort = undefined;
        backoff.finishProbe(ticket, success);
      }
    },
    stopAspRequests: () => {
      stopped = true;
      generation += 1;
      probeAbort?.abort();
      pacer.cancelPending();
      backoff.pause();
    },
    startAspRequests: () => { stopped = false; backoff.resume(); },
  };
}

/**
 * The app's single ASP backoff and pacer, shared by every chain and feed.
 * Every ASP request (APIClient, the SDK's HTTP adapter, the viewing-key sync)
 * passes policedFetch, the one place that can promise nothing leaves the
 * browser while the ASP is throttling us.
 */
export const aspBackoff = createAspBackoff();
export const aspPacer = createAspPacer();
export const { policedFetch, probeAsp, startAspRequests, stopAspRequests } = createEgressFetch(aspBackoff, aspPacer);
