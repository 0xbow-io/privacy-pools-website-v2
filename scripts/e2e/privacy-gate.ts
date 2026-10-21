/**
 * The network-privacy gate, applied to a real journey.
 *
 * `network-privacy.ts` is the engine: given requests, secrets and a host map
 * it says what leaked. This module is everything needed to point that engine
 * at an actual browser run — who the parties are, where the journey's secrets
 * come from, which background traffic is allowed to fire while the user is
 * opening a form, and what we have knowingly not fixed yet.
 *
 * Kept separate from the engine on purpose: the policy is a moving target
 * argued over per endpoint, and the detection should stop changing once it is
 * right.
 */
import {
  classifyDestination,
  describeLeaks,
  findLeaks,
  pollBody,
  findTimingViolations,
  type AlwaysOnPollMatcher,
  type CapturedRequest,
  type Destination,
  type DestinationHosts,
  type JourneySecrets,
  type Leak,
  type PollBudget,
} from './network-privacy';

/**
 * Who is who on the wire.
 *
 * ASP / RPC / relayer entries are DNS NAMES and match subdomains; own-origin
 * entries are full origins and match exactly. Both of those are the engine's
 * rules, and both matter: a hostname PREFIX (`relayer-v2-`) matches nothing at
 * all, so it would quietly reclassify the relayer as an unknown third party
 * and fail the run on correct behaviour. Real names only.
 *
 * Configuration comes in as arguments rather than being read from .env here,
 * so this module imports nothing from the playwright harness and stays unit
 * testable. The journey passes what it is actually pointed at.
 */
export function resolveHosts(config: {
  aspUrl?: string;
  rpcUrl?: string;
  rpcUrls?: string[];
  /** The origin the app is served from in this run. */
  ownOrigin?: string;
}): DestinationHosts {
  const originOf = (url: string | undefined): string[] => {
    if (!url) return [];
    try {
      return [new URL(url).origin];
    } catch {
      return [];
    }
  };
  const hostnameOf = (url: string | undefined): string[] => {
    if (!url) return [];
    try {
      return [new URL(url).hostname.toLowerCase()];
    } catch {
      return [];
    }
  };
  return {
    asp: [...hostnameOf(config.aspUrl), 'api-dev.0xbow.io', 'api-v2.0xbow.io'],
    rpc: [
      ...(config.rpcUrls ?? []).flatMap(originOf),
      ...hostnameOf(config.rpcUrl),
      'g.alchemy.com',
      'infura.io',
      'publicnode.com',
      'drpc.org',
      'llamarpc.com',
      'ankr.com',
      'rpc.sepolia.org',
      'cloudflare-eth.com',
    ],
    // Full hostnames, from config/relayer-eras.ts and config/chains.ts.
    relayer: [
      'relayer-v2-prod-149184580131.us-east1.run.app',
      'relayer-staging.example',
      'relayer-testing.example',
      'testnet-relayer.privacypools.com',
    ],
    // Exact origin: a subdomain of our own site is not automatically ours, and
    // treating it as own-origin would exempt it from every content check.
    ownOrigin: originOf(config.ownOrigin).flatMap((origin) => [origin, origin.replace(/^http/, 'ws')]),
  };
}

/**
 * Traffic allowed to appear inside a timing window no matter what.
 *
 * Kept SHORT on purpose. The measured baseline below is what absorbs ordinary
 * background polling; this list is only for traffic that cannot show up in a
 * quiet baseline because it is genuinely bursty — a bundle chunk fetched the
 * first time a lazily-loaded screen renders.
 *
 * These are regexes, so per the engine they carry NO count budget: they say
 * "this URL may appear", not "this URL may appear twice". That is acceptable
 * for dev-server assets and for nothing else.
 */
export const ALWAYS_ALLOWED_IN_WINDOW: RegExp[] = [
  /\/(_expo|node_modules|assets|\.expo)\//,
  /\.(bundle|map|js|css|woff2?|ttf|png|jpe?g|svg|ico)(\?|$)/,
  /\/symbolicate|\/hot\b|\/message\b/,
];

/**
 * Leaks we know about, have decided about, and have not fixed yet.
 *
 * A waiver is a promise to come back, so each carries who it is waiting on.
 * The gate reports an UNUSED waiver as a failure: once the leak is gone the
 * line must go too, or the list rots into a permanent exemption and the next
 * real leak lands inside it unnoticed.
 *
 * These mirror what services/egress-policy.ts allows on purpose. The two
 * lists are deliberately separate — one is what the runtime refuses, the other
 * is what an observed journey tolerates — but they must name the same debts.
 */
export type Waiver = {
  /** Matches the offending request URL. */
  url: RegExp;
  kind: keyof JourneySecrets;
  destination: Destination;
  /** What it is and what clears it. */
  reason: string;
  /**
   * A waiver for traffic that only happens on SOME runs (a failure report) is
   * not stale when a run never produced that traffic. Everything else stays
   * mandatory: the stale check is what keeps this list from rotting.
   */
  optional?: true;
};

export const WAIVERS: Waiver[] = [
  {
    url: /\/\/[a-z0-9]+\.ingest\.(?:[a-z]+\.)?sentry\.io\/api\/\d+\/envelope\b/,
    kind: 'addresses',
    destination: 'other',
    optional: true,
    reason:
      'A STAGING session that reports a failed flow attaches the session address, amount '
      + 'and raw error to the Sentry event on purpose (contexts.diagnostic, gated on the '
      + 'staging environment in services/error-reports.ts; Pat, 2026-09-16: staging must '
      + 'provide the rich data, prod sends booleans only). The journey runs on staging, so a '
      + 'failed step legitimately ships this envelope; it is the one error reporting destination '
      + 'services/egress-policy.ts allows. Clears when staging diagnostics drop the address.',
  },
];

/** A leak matched by a waiver is reported, not failed. */
function waiverFor(leak: Leak, waivers: readonly Waiver[]): Waiver | undefined {
  return waivers.find(
    (w) => w.kind === leak.kind && w.destination === leak.destination && w.url.test(leak.request.url),
  );
}

/**
 * The secrets a journey actually held, read out of the app rather than
 * guessed.
 *
 * Reading the app's own stored export is the point: a hand-written list of
 * "values we think are secret" only ever covers the leak you already imagined.
 * Whatever the app decided to keep about a note is what an observer would
 * recognise if it went out on the wire.
 *
 * The limit, stated because the engine cannot state it for you: a value the
 * app DERIVES and never stores — a fresh hash, an encryption of a note — is
 * invisible to a matcher no matter how many encodings it enumerates. Declaring
 * such a value here is the only way it becomes checkable.
 */
export async function collectJourneySecrets(
  page: { evaluate: <T>(fn: (...a: never[]) => T) => Promise<T> },
  extra: { addresses?: string[]; amountsWei?: (string | bigint)[] } = {},
): Promise<JourneySecrets> {
  const harvested = await page.evaluate(() => {
    const labels: string[] = [];
    const commitments: string[] = [];
    const nullifiers: string[] = [];
    const amounts: string[] = [];
    const other: string[] = [];
    const addresses: string[] = [];

    // A note is a nested object and the SDK renames fields between versions,
    // so classify by key name on the way down rather than by a fixed shape.
    const walk = (node: unknown, key: string, depth: number): void => {
      if (depth > 8) return;
      if (node === null || node === undefined) return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item, key, depth + 1);
        return;
      }
      if (typeof node === 'object') {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, k, depth + 1);
        return;
      }
      const value = String(node);
      if (!value || value === '0' || value === '0x') return;
      const k = key.toLowerCase();
      // Chain/asset metadata is public and shared by unrelated accounts; it
      // cannot identify a private note. Padded block numbers are not hashes.
      if (['chainid', 'synccursor', 'createdatblock', 'spentatblock', 'tokenid'].includes(k)) return;
      if (/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value) && BigInt(value) === 0n) return;
      if ((k === 'owner' || k.endsWith('address')) && /^0x[0-9a-f]{40}$/i.test(value)) addresses.push(value);
      else if (k.includes('label')) labels.push(value);
      else if (k.includes('commitment')) commitments.push(value);
      else if (k.includes('nullifier')) nullifiers.push(value);
      else if (k === 'value' || k.includes('amount')) amounts.push(value);
      // Anything else long and opaque a note carries — secrets, precommitments,
      // note-address hashes — is still ours and still recognisable on the wire.
      else if (/^0x[0-9a-f]{40,}$/i.test(value)) other.push(value);
    };

    const stores: Storage[] = [];
    try {
      stores.push(sessionStorage);
    } catch {
      /* unavailable */
    }
    try {
      stores.push(localStorage);
    } catch {
      /* unavailable */
    }
    for (const store of stores) {
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (!key || !/ppv2_(account_export|unanchored_notes|sui_notes)/.test(key)) continue;
        const raw = store.getItem(key);
        if (!raw) continue;
        try {
          walk(JSON.parse(raw), key, 0);
        } catch {
          /* not JSON — nothing to harvest */
        }
      }
    }
    const uniq = (xs: string[]) => [...new Set(xs)];
    return {
      addresses: uniq(addresses),
      labels: uniq(labels),
      commitments: uniq([...commitments, ...other]),
      nullifiers: uniq(nullifiers),
      amountsWei: uniq(amounts),
    };
  });

  return {
    // ONE bucket, not both. In v2 a note's `label` IS the hash the ASP
    // indexes, and the policy forbids `labels` and `labelHashes` at exactly
    // the same destinations, so declaring the same value twice bought nothing
    // and reported every label leak twice — which makes one finding read as a
    // worse problem than it is, and a gate that inflates is a gate people
    // start discounting.
    //
    // If a build ever sends a DISTINCT hash form (v1 sent both), harvest it
    // into `labelHashes` then; the separate bucket exists for that day.
    labels: harvested.labels,
    commitments: harvested.commitments,
    nullifiers: harvested.nullifiers,
    amountsWei: [...harvested.amountsWei, ...(extra.amountsWei ?? []).map(String)],
    addresses: [...new Set([...(harvested.addresses ?? []), ...(extra.addresses ?? [])])],
  };
}

export type TimingWindow = {
  /** What the user did, for the failure message. */
  action: string;
  /**
   * Quiet stretches before the action, with the app in the same state and each
   * the SAME LENGTH as the action window, used to measure what polls on its
   * own. More than one because a 30s poll lands once in some 20s windows and
   * twice in others purely by phase; two controls make that visible instead of
   * turning it into a failure.
   */
  baselines: { start: number; end: number }[];
  start: number;
  end: number;
};

/**
 * Slack added to every measured poll budget.
 *
 * A background poll whose period straddles a window boundary fires n or n+1
 * times depending only on when the window opened. Without this, that phase
 * difference reads as "the form caused a request", the gate cries wolf, and a
 * gate that cries wolf gets switched off.
 *
 * The price is real and worth naming: the gate will not notice ONE extra call
 * to an endpoint that already polls. What it does notice with no slack at all
 * is a request to an endpoint that was not being called before — which is the
 * shape both disclosed leaks had, since neither endpoint was touched until the
 * withdraw form opened.
 */
const POLL_HEADROOM = 1;

/**
 * Turn a measured quiet period into exact poll budgets.
 *
 * A URL-substring allowlist is the wrong shape twice over: it lets a
 * form-triggered request hide behind a background endpoint it happens to
 * share, and it puts no ceiling on how many times that endpoint may be hit. So
 * the baseline is converted into exact (url, method, kind, body) rules with
 * the count observed there as the budget. An extra call to an allowed endpoint
 * is then a violation, which is exactly the case a substring match misses.
 */
export function pollBudgetsFrom(baselines: CapturedRequest[][]): PollBudget[] {
  const worst = new Map<string, { poll: Omit<PollBudget, 'maxRequests'>; n: number }>();
  for (const baseline of baselines) {
    const counts = new Map<string, { poll: Omit<PollBudget, 'maxRequests'>; n: number }>();
    for (const r of baseline) {
      const key = JSON.stringify([r.url, r.method, r.kind, pollBody(r.body)]);
      const seen = counts.get(key);
      if (seen) seen.n += 1;
      else counts.set(key, { poll: { url: r.url, method: r.method, kind: r.kind, body: pollBody(r.body) }, n: 1 });
    }
    // The BUSIEST control wins: a shape that fired twice in one idle window can
    // fire twice in the action window without the user having caused anything.
    for (const [key, entry] of counts) {
      const best = worst.get(key);
      if (!best || entry.n > best.n) worst.set(key, entry);
    }
  }
  return [...worst.values()].map(({ poll, n }) => ({
    ...poll,
    maxRequests: n + POLL_HEADROOM,
  }));
}

/**
 * Did anything fire *because* the user opened the withdraw form?
 *
 * Honest about what this proves: a window shows unexpected traffic, not
 * causation. A background poll whose period straddles the boundary, a retry,
 * or a react-query refetch-on-focus can all land inside it. The budgets make
 * that much harder to hide behind and much harder to cry wolf about, but the
 * only real answer is an equal-length idle control with the same prepared
 * state, repeated at different poll phases — which is what the journey does.
 */
export function timingViolationsFor(
  captured: CapturedRequest[],
  window: TimingWindow,
  hosts: DestinationHosts,
): { detail: string; request: CapturedRequest }[] {
  // Own-origin dev traffic is Metro, not a party we are hiding from.
  const thirdParty = captured.filter((r) => classifyDestination(r.url, hosts) !== 'own-origin');
  const baselines = window.baselines.map((b) =>
    thirdParty.filter((r) => r.t >= b.start && r.t < b.end && r.method !== 'OPTIONS'),
  );
  const allowed: AlwaysOnPollMatcher = [...ALWAYS_ALLOWED_IN_WINDOW, ...pollBudgetsFrom(baselines)];
  const violations = findTimingViolations(thirdParty, window.start, window.end, allowed);
  const rejected = new Set(violations.map(v => v.request));
  const polls = thirdParty.filter(r => r.t >= window.start && r.t < window.end
    && r.kind === 'http' && r.method !== 'OPTIONS' && !rejected.has(r));
  // CORS permission may expire between controls and action. A preflight must
  // pair one-to-one with an actual, budget-approved poll in this same window.
  // Content checks still inspect both requests, including preflight headers.
  return violations.filter(({ request }) => {
    if (request.kind !== 'http' || request.method !== 'OPTIONS' || request.body || request.bodyBase64) return true;
    const method = Object.entries(request.headers).find(([name]) => name.toLowerCase() === 'access-control-request-method')?.[1];
    const index = polls.findIndex(p => p.url === request.url && p.method === method);
    if (index < 0) return true;
    polls.splice(index, 1);
    return false;
  });
}

/** A submitted proof publishes its NEW outputs, never its input commitments.
 * Strip only those output slots from the copy inspected by the content gate;
 * duplicate values in headers, other fields, or other requests remain checked.
 */
function submittedProof(request: CapturedRequest, outputs: readonly string[], hosts: DestinationHosts): CapturedRequest {
  if (!outputs.length || request.method !== 'POST' || request.bodyBase64
    || classifyDestination(request.url, hosts) !== 'relayer'
    || !/^\/v1\/relay\/evm\/\d+\/(withdrawal|transfer)$/.test(new URL(request.url).pathname)) return request;
  try {
    const body = JSON.parse(request.body ?? '');
    const start = body.inputNullifierNumber;
    const count = body.outputCommitmentNumber;
    const signals = body.proof?.publicSignals;
    if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(count) || count < 1
      || !Array.isArray(signals) || start + count > signals.length) return request;
    const allowed = new Set(outputs.map(value => BigInt(value).toString()));
    for (let i = start; i < start + count; i++) {
      if (allowed.has(BigInt(signals[i]).toString())) signals[i] = '0x0';
    }
    return { ...request, body: JSON.stringify(body) };
  } catch { return request; } // An unfamiliar payload retains the strict policy.
}

export type GateReport = {
  ok: boolean;
  detail: string;
  /** Everything the gate saw, so a failure can be argued with rather than guessed at. */
  text: string;
};

/**
 * Run both halves and produce one verdict.
 *
 * Waived leaks and unused waivers are both surfaced: the first so a known gap
 * stays visible on every run, the second so a closed gap cannot leave its
 * exemption behind.
 */
export function runNetworkPrivacyGate(args: {
  captured: CapturedRequest[];
  secrets: JourneySecrets;
  hosts: DestinationHosts;
  windows?: TimingWindow[];
  /** Commitments created by this confirmed journey, absent before submission. */
  submittedCommitments?: string[];
  /** Defaults to WAIVERS. Tests pass their own to exercise the stale check. */
  waivers?: readonly Waiver[];
}): GateReport {
  const waivers = args.waivers ?? WAIVERS;
  const hosts = args.hosts;
  const requests = args.captured.map(r => submittedProof(r, args.submittedCommitments ?? [], hosts));
  const all = findLeaks(requests, args.secrets, hosts);
  const waived: { leak: Leak; waiver: Waiver }[] = [];
  const failing: Leak[] = [];
  for (const leak of all) {
    const waiver = waiverFor(leak, waivers);
    if (waiver) waived.push({ leak, waiver });
    else failing.push(leak);
  }
  const unusedWaivers = waivers.filter((w) => !w.optional && !waived.some((x) => x.waiver === w));

  const timing: { window: TimingWindow; detail: string; request: CapturedRequest }[] = [];
  let timingError: string | undefined;
  for (const w of args.windows ?? []) {
    try {
      for (const v of timingViolationsFor(args.captured, w, hosts)) timing.push({ window: w, ...v });
    } catch (err) {
      // An incomplete capture throws rather than returning clean. A gate that
      // swallowed that would report "no violations" for traffic it never saw.
      timingError = `${w.action}: ${(err as Error).message}`;
    }
  }

  const lines: string[] = [];
  lines.push(`observed ${args.captured.length} outbound requests`);
  const byDestination = new Map<Destination, number>();
  for (const r of args.captured) {
    const d = classifyDestination(r.url, hosts);
    byDestination.set(d, (byDestination.get(d) ?? 0) + 1);
  }
  lines.push(`  by destination: ${[...byDestination].map(([d, n]) => `${d}=${n}`).join(' ') || 'none'}`);
  if (failing.length) lines.push(describeLeaks(failing));
  for (const { leak, waiver } of waived) {
    lines.push(`  WAIVED ${leak.destination} ${leak.kind} in ${leak.where}: ${leak.detail}\n    ${waiver.reason}`);
  }
  for (const w of unusedWaivers) {
    lines.push(
      `  STALE WAIVER: nothing matched ${w.destination}/${w.kind} ${w.url}. `
      + 'If the leak is fixed, delete the waiver.',
    );
  }
  for (const t of timing) {
    lines.push(`  TIMING: "${t.window.action}" caused a request no measured background poll explains\n    ${t.detail}`);
  }
  if (timingError) lines.push(`  CAPTURE INCOMPLETE: ${timingError}`);

  const ok =
    failing.length === 0 && timing.length === 0 && unusedWaivers.length === 0 && !timingError;
  const parts = [
    `${failing.length} leak(s)`,
    `${timing.length} timing violation(s)`,
    `${waived.length} waived`,
    `${unusedWaivers.length} stale waiver(s)`,
  ];
  if (timingError) parts.push('capture incomplete');
  return { ok, detail: parts.join(', '), text: lines.join('\n') };
}

/**
 * The whole end-of-run verdict, as ONE typed call.
 *
 * The journey script carries `@ts-nocheck` — playwright is a local dev tool
 * here, typed against a fallback stub — so an argument of the wrong shape at
 * its call site would be invisible until a funded CI run. Assembling the call
 * here, where the typechecker does look, means the journey passes only simple
 * values and cannot get the shape wrong.
 *
 * `flush` is a parameter rather than an import so this module keeps no
 * dependency on the harness and stays unit-testable.
 */
export async function reportJourneyPrivacy(args: {
  page: { evaluate: <T>(fn: (...a: never[]) => T) => Promise<T> };
  captured: CapturedRequest[];
  /** Must run before asserting: an incomplete observation is a failure, not a pass. */
  flush: () => Promise<void>;
  windows: TimingWindow[];
  addresses: string[];
  amountsWei?: (string | bigint)[];
  aspUrl?: string;
  rpcUrl?: string;
  rpcUrls?: string[];
  ownOrigin?: string;
}): Promise<{ ok: boolean; detail: string; text: string }> {
  try {
    await args.flush();
    const secrets = await collectJourneySecrets(args.page, { addresses: args.addresses, amountsWei: args.amountsWei });
    const report = runNetworkPrivacyGate({
      captured: args.captured,
      secrets,
      hosts: resolveHosts({
        aspUrl: args.aspUrl,
        rpcUrl: args.rpcUrl,
        rpcUrls: args.rpcUrls,
        ownOrigin: args.ownOrigin,
      }),
      windows: args.windows,
    });
    // A run that never opened the form measured no window, and a gate that
    // passes on zero evidence is the failure mode this whole exercise exists
    // to remove.
    if (args.windows.length === 0) {
      return {
        ok: false,
        detail: 'no timing window was measured, so nothing was proven',
        text: report.text,
      };
    }
    return report;
  } catch (err) {
    return {
      ok: false,
      detail: `gate could not run: ${(err as Error).message}`,
      text: String((err as Error).stack ?? err),
    };
  }
}
