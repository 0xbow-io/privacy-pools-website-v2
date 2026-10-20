/**
 * Custom RPC endpoints: let a user point one chain at their own node - PURE
 * module (no react-native imports; browser globals only behind guards) so bun
 * tests can import it.
 *
 * Shape: one endpoint PER CHAIN, keyed by chain id. A single global override
 * would be wrong here - the app serves several chains behind one selector, and
 * an Ethereum endpoint answering for Citrea is not a degraded experience, it is
 * a broken one.
 *
 * Resolution happens ONCE at module load and config/chains.ts bakes the result
 * into its chain records, so switching is a persist-and-reload, the same
 * pattern as config/app-environment.ts. There is deliberately no hot swap: the
 * SDK session, query caches and the wagmi transports are built from those
 * records once per page load.
 *
 * The override is EXCLUSIVE: when a chain carries one, it becomes that chain's
 * only endpoint, with no silent fall back to ours. Keeping our endpoints behind
 * it as fallbacks would quietly send a share of the traffic to the provider the
 * user just chose to stop using, which is most of the reason to set one.
 *
 * PRIVACY. The URL a user types is theirs. It is read from storage and handed
 * to viem, and nowhere else: never to the ASP, the relayer, an analytics or
 * error-reporting call, and never into a URL query string (which is why there
 * is no `?rpc=` override to match app-environment's `?env=`, and why applying
 * one reloads in place). Do not log it above debug level. See
 * docs/privacy-request-discipline.md.
 */

/** Per-chain endpoints, keyed by chain id. */
export type CustomRpcOverrides = Readonly<Record<number, string>>;

export const CUSTOM_RPC_STORAGE_KEY = 'ppv2_custom_rpc_v1';

/** Why a URL was refused. The UI maps these to the messages below. */
export type CustomRpcRejection =
  | 'empty'
  | 'unparseable'
  | 'scheme'
  | 'credentials';

export type CustomRpcValidation =
  | { ok: true; url: string }
  | { ok: false; reason: CustomRpcRejection; message: string };

/**
 * Hosts allowed to speak plain http. A local node is the one endpoint a user
 * cannot serve over TLS, and it never leaves the machine; everything else must
 * be https, so the endpoint cannot be read or rewritten in transit.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === '[::1]'
    || host === '::1'
    || host.endsWith('.localhost');
}

/**
 * Validate a user-typed endpoint. Pure, and the single source of truth for what
 * the app will accept - the modal, the stored-value reader and the tests all go
 * through it, so a value that could never be typed cannot arrive via storage
 * either.
 */
export function validateCustomRpcUrl(raw: string | null | undefined): CustomRpcValidation {
  const trimmed = raw?.trim() ?? '';
  if (trimmed.length === 0) {
    return { ok: false, reason: 'empty', message: 'Enter an RPC URL.' };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      ok: false,
      reason: 'unparseable',
      message: 'That is not a valid URL. It should start with https://',
    };
  }
  // `new URL` normalises "https:rpc.example.com" and "https:/rpc.example.com"
  // into a perfectly good URL object, but the string we store is the one the
  // user typed, and the SDK's own RpcUrlSchema requires "://" - so those two
  // spellings passed here and then threw InvalidRpcUrl after the reload
  // (codex, 2026-09-11). Require the canonical form instead of normalising,
  // so what is stored is what was checked.
  if (!/^https?:\/\//i.test(trimmed)) {
    return {
      ok: false,
      reason: 'scheme',
      message: 'The URL must start with https:// (http:// is allowed for localhost only).',
    };
  }
  // Credentials in the URL would be stored in plain text and sent on every
  // single call. A provider that needs a secret puts it in the path or query.
  if (url.username.length > 0 || url.password.length > 0) {
    return {
      ok: false,
      reason: 'credentials',
      message: 'Remove the username and password from the URL.',
    };
  }
  if (url.protocol === 'https:') return { ok: true, url: trimmed };
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) {
    return { ok: true, url: trimmed };
  }
  return {
    ok: false,
    reason: 'scheme',
    message: 'The URL must start with https:// (http:// is allowed for localhost only).',
  };
}

/**
 * Parse the stored blob. Every entry is re-validated: storage is writable by
 * anything running on the origin, and a bad value here becomes the endpoint
 * every call goes to. A malformed blob resolves to "no overrides" rather than
 * throwing, so storage a user (or an extension) scribbled on cannot take the
 * config layer down at import time.
 */
export function parseCustomRpcOverrides(raw: string | null | undefined): CustomRpcOverrides {
  if (!raw) return {};
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return {};
  const out: Record<number, string> = {};
  for (const [key, value] of Object.entries(decoded as Record<string, unknown>)) {
    const chainId = Number(key);
    if (!Number.isInteger(chainId) || chainId <= 0) continue;
    if (typeof value !== 'string') continue;
    const checked = validateCustomRpcUrl(value);
    if (checked.ok) out[chainId] = checked.url;
  }
  return out;
}

export function serializeCustomRpcOverrides(overrides: CustomRpcOverrides): string {
  return JSON.stringify(overrides);
}

/** The endpoint configured for a chain, or undefined when it uses ours. */
export function customRpcUrlFor(
  overrides: CustomRpcOverrides,
  chainId: number,
): string | undefined {
  return overrides[chainId];
}

/**
 * Does the override map hold an endpoint for this chain — the pure core of
 * `usesCustomRpc` (config/chains.ts). Lives here, not there, for the same
 * reason `queryableChainIds` does: `bun test` cannot import config/chains at
 * all (it pulls react-native in), so the privacy-relevant split this function
 * decides — is a chain's traffic ours or the user's own RPC — has to be
 * testable on its own.
 */
export function hasCustomRpcOverride(
  overrides: CustomRpcOverrides,
  chainId: number,
): boolean {
  return !!customRpcUrlFor(overrides, chainId);
}

/**
 * The endpoint list a chain should actually use. An override REPLACES the
 * configured list (see the header); with none, the defaults stand.
 */
export function resolveChainRpcUrls(
  overrides: CustomRpcOverrides,
  chainId: number,
  defaults: readonly string[],
): string[] {
  const custom = customRpcUrlFor(overrides, chainId);
  return custom ? [custom] : [...defaults];
}

/**
 * Apply a change to the map, in memory. `url` of null clears the chain's entry,
 * which is how "use our RPC again" is expressed. An invalid URL is refused, so
 * a caller that skipped validation cannot store one.
 */
export function withCustomRpc(
  overrides: CustomRpcOverrides,
  chainId: number,
  url: string | null,
): CustomRpcOverrides {
  const next: Record<number, string> = { ...overrides };
  if (url === null) {
    delete next[chainId];
    return next;
  }
  const checked = validateCustomRpcUrl(url);
  if (!checked.ok) return overrides;
  next[chainId] = checked.url;
  return next;
}

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * Read the overrides from a storage. Every read is wrapped: a missing or
 * throwing storage (private mode, disabled site data) means "no overrides"
 * rather than an import-time crash.
 */
export function readCustomRpcOverrides(storage: StorageLike | null | undefined): CustomRpcOverrides {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(CUSTOM_RPC_STORAGE_KEY) ?? null;
  } catch {
    raw = null;
  }
  return parseCustomRpcOverrides(raw);
}

/**
 * Write the overrides back, dropping the key entirely once it is empty.
 * Returns whether the choice is now durable: a refused write (private mode,
 * blocked site data, exhausted quota) must NOT be reported to the user as a
 * saved setting, because the reload would land on the old endpoint.
 */
export function writeCustomRpcOverrides(
  storage: StorageLike | null | undefined,
  overrides: CustomRpcOverrides,
): boolean {
  if (!storage) return false;
  try {
    if (Object.keys(overrides).length === 0) {
      storage.removeItem(CUSTOM_RPC_STORAGE_KEY);
      return true;
    }
    storage.setItem(CUSTOM_RPC_STORAGE_KEY, serializeCustomRpcOverrides(overrides));
    return true;
  } catch {
    return false;
  }
}

/**
 * Where the endpoint is kept, and for how long.
 *
 * `local` outlives the browser session; `session` is gone when the tab
 * closes. Both survive the reload that applying a change triggers, which is
 * what makes `session` viable at all: the feature only takes effect on a
 * reload, so a store that did not survive one would be a store that never
 * worked.
 *
 * Worth being exact about what unchecking buys, because "does not persist" is
 * easy to over-read: sessionStorage is per tab and per origin. It survives
 * refresh and back/forward in THAT tab, and is invisible to every other tab
 * and gone when this one closes. It is not a privacy boundary against anything
 * running on the page, which can read either store.
 */
export type CustomRpcPersistence = 'local' | 'session';

function storageFor(persistence: CustomRpcPersistence): StorageLike | null {
  if (typeof window === 'undefined') return null;
  try {
    return (persistence === 'local' ? window.localStorage : window.sessionStorage) ?? null;
  } catch {
    return null;
  }
}

/**
 * Which store currently holds a value.
 *
 * Session wins when both do. That can only happen if a write half-failed, and
 * between a session-scoped value and a persistent one the narrower is the
 * safer thing to honour: a user who asked for "gone when I close this tab"
 * should not silently get the persistent copy instead. Writes clear the other
 * store precisely so this stays hypothetical.
 */
function occupiedStorage(): { storage: StorageLike | null; persistence: CustomRpcPersistence } {
  const session = storageFor('session');
  try {
    if (session?.getItem(CUSTOM_RPC_STORAGE_KEY)) {
      return { storage: session, persistence: 'session' };
    }
  } catch {
    /* blocked site data; fall through to local */
  }
  return { storage: storageFor('local'), persistence: 'local' };
}

function activeStorage(): StorageLike | null {
  return occupiedStorage().storage;
}

/**
 * Is the endpoint in force this page load a persistent one?
 *
 * Defaults to `local` when nothing is stored, so the form's checkbox starts
 * ticked and today's behaviour is what a user gets by doing nothing.
 */
export const ACTIVE_CUSTOM_RPC_PERSISTENCE: CustomRpcPersistence = occupiedStorage().persistence;

/** Resolved once at module load; changing it requires a reload (by design). */
export const ACTIVE_CUSTOM_RPC_OVERRIDES: CustomRpcOverrides =
  readCustomRpcOverrides(activeStorage());

export function getActiveCustomRpcOverrides(): CustomRpcOverrides {
  return ACTIVE_CUSTOM_RPC_OVERRIDES;
}

/** The endpoint in force for a chain this page load, or undefined for ours. */
export function activeCustomRpcUrl(chainId: number): string | undefined {
  return customRpcUrlFor(ACTIVE_CUSTOM_RPC_OVERRIDES, chainId);
}

/**
 * Persist a choice and reload, so the config constants, the wagmi transports
 * and the SDK session are all rebuilt against the new endpoint.
 *
 * Unlike the environment switch there is NO query parameter in the reload
 * target: the endpoint is the user's, and a URL carrying it would end up in
 * history, in a shared link and in the referrer of anything the page loads.
 *
 * The change is merged into what storage holds NOW, not into this page's
 * startup snapshot: a second tab may have set another chain's endpoint since
 * this one loaded, and merging against the snapshot would delete it (codex,
 * 2026-09-11). Returns false when nothing was stored, so the caller can say so
 * instead of reloading into the endpoint the user just tried to change.
 */
export function applyCustomRpc(chainId: number, url: string | null): boolean {
  const storage = activeStorage();
  const next = withCustomRpc(readCustomRpcOverrides(storage), chainId, url);
  if (!writeCustomRpcOverrides(storage, next)) return false;
  // Web only: `window` exists under React Native too (it is `global`), but
  // `window.location` does not, and calling reload there throws.
  if (typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
    window.location.reload();
  }
  return true;
}

export function previewCustomRpcMany(
  entries: Readonly<Record<number, string | null>>,
): CustomRpcOverrides {
  // The warning and the write must include endpoints saved by another tab,
  // including chains that this build does not display in its form.
  let next = readCustomRpcOverrides(activeStorage());
  for (const [key, url] of Object.entries(entries)) {
    next = withCustomRpc(next, Number(key), url);
  }
  return next;
}

/**
 * Write the whole set to ONE store and clear the other.
 *
 * Clearing the other is the load-bearing half. Without it, unticking "keep
 * this after I close the browser" would write a session copy and leave the
 * persistent one sitting there, so the endpoint the user asked to forget
 * would come back on the next visit. Two stores holding different answers is
 * also how the read order above starts mattering, and it should never have to.
 */
export function applyCustomRpcMany(
  entries: Readonly<Record<number, string | null>>,
  persistence: CustomRpcPersistence = ACTIVE_CUSTOM_RPC_PERSISTENCE,
): boolean {
  const target = storageFor(persistence);
  const other = storageFor(persistence === 'local' ? 'session' : 'local');

  // Merge against whichever store holds the current answer, so another tab's
  // chain is not dropped when this one saves.
  const next = previewCustomRpcMany(entries);
  if (!writeCustomRpcOverrides(target, next)) return false;
  try {
    other?.removeItem(CUSTOM_RPC_STORAGE_KEY);
  } catch {
    // Do not claim the persistence change succeeded while the old copy remains.
    return false;
  }
  if (typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
    window.location.reload();
  }
  return true;
}

// ---------------------------------------------------------------------------
// Provider prefill
// ---------------------------------------------------------------------------

/**
 * An RPC endpoint speaks for ONE chain. That is why the stored shape is a map
 * and why the form asks per chain.
 *
 * It is also why filling the form is tedious: a user of a hosted provider holds
 * one key and pastes six nearly identical URLs that differ by a network token.
 * So when we recognise the provider we offer to derive the siblings. OFFER, not
 * apply: a derived URL is a guess about someone else's URL scheme, and a guess
 * that silently became the endpoint every call goes to would be exactly the
 * wrong kind of helpful.
 *
 * Derivation is deliberately narrow. A provider appears here only when its
 * per-chain form is a documented token substitution, and a chain appears only
 * when we know that provider's token for it. Anything else derives nothing,
 * which is the honest answer rather than a plausible URL that 404s.
 */
export type RpcProvider = 'alchemy' | 'ankr' | 'drpc' | 'dappnode';

/** `<network>.g.alchemy.com/v2/<key>` */
const ALCHEMY_NETWORKS: Readonly<Record<number, string>> = {
  1: 'eth-mainnet',
  11155111: 'eth-sepolia',
  10: 'opt-mainnet',
  42161: 'arb-mainnet',
  8453: 'base-mainnet',
  56: 'bnb-mainnet',
  4663: 'robinhood-mainnet',
};

/** `rpc.ankr.com/<network>/<key>` */
const ANKR_NETWORKS: Readonly<Record<number, string>> = {
  1: 'eth',
  11155111: 'eth_sepolia',
  10: 'optimism',
  42161: 'arbitrum',
  8453: 'base',
  56: 'bsc',
};

/** `lb.drpc.org/ogrpc?network=<network>&dkey=<key>` */
const DRPC_NETWORKS: Readonly<Record<number, string>> = {
  1: 'ethereum',
  11155111: 'sepolia',
  10: 'optimism',
  42161: 'arbitrum',
  8453: 'base',
  56: 'bsc',
};

/**
 * Which hosted provider this endpoint belongs to, if any.
 *
 * DAppNode is recognised but derives nothing: a DAppNode user runs a separate
 * package per chain on its own hostname, so there is no token to swap and a
 * guess would be wrong. Naming it is still worth it - the form can say "looks
 * like DAppNode, set the others yourself" instead of silently offering nothing.
 */
export function detectRpcProvider(raw: string): RpcProvider | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  if (host.endsWith('.g.alchemy.com')) return 'alchemy';
  if (host === 'rpc.ankr.com' || host.endsWith('.rpc.ankr.com')) return 'ankr';
  if (host.endsWith('drpc.org')) return 'drpc';
  if (host === 'dappnode' || host.endsWith('.dappnode')) return 'dappnode';
  return undefined;
}

function networksFor(provider: RpcProvider): Readonly<Record<number, string>> | undefined {
  if (provider === 'alchemy') return ALCHEMY_NETWORKS;
  if (provider === 'ankr') return ANKR_NETWORKS;
  if (provider === 'drpc') return DRPC_NETWORKS;
  return undefined;
}

/**
 * Rewrite one endpoint for the other chains it could serve.
 *
 * `sourceChainId` is the row the URL was typed into, and it must be one this
 * provider has a token for AND the URL must actually carry that token: if
 * someone pastes an Arbitrum URL into the Ethereum row we derive nothing
 * rather than propagating a mistake to five more chains. Targets we cannot
 * name are omitted, never approximated.
 */
export function deriveSiblingRpcUrls(
  raw: string,
  sourceChainId: number,
  targetChainIds: readonly number[],
): Readonly<Record<number, string>> {
  const provider = detectRpcProvider(raw);
  if (!provider) return {};
  const networks = networksFor(provider);
  const sourceToken = networks?.[sourceChainId];
  if (!networks || !sourceToken) return {};

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return {};
  }

  const rewrite = (token: string): string | undefined => {
    const next = new URL(url.href);
    if (provider === 'alchemy') {
      if (!next.hostname.toLowerCase().startsWith(`${sourceToken}.`)) return undefined;
      next.hostname = `${token}${next.hostname.slice(sourceToken.length)}`;
      return next.href;
    }
    if (provider === 'ankr') {
      const segments = next.pathname.split('/');
      // ['', '<network>', ...]
      if (segments[1] !== sourceToken) return undefined;
      segments[1] = token;
      next.pathname = segments.join('/');
      return next.href;
    }
    // drpc
    if (next.searchParams.get('network') !== sourceToken) return undefined;
    next.searchParams.set('network', token);
    return next.href;
  };

  const derived: Record<number, string> = {};
  for (const chainId of targetChainIds) {
    if (chainId === sourceChainId) continue;
    const token = networks[chainId];
    if (!token) continue;
    const candidate = rewrite(token);
    // Round-trip through the validator: a derived URL is subject to exactly
    // the same rules as a typed one, so prefill cannot introduce a value the
    // form would have refused.
    if (candidate && validateCustomRpcUrl(candidate).ok) derived[chainId] = candidate;
  }
  return derived;
}

// ---------------------------------------------------------------------------
// Reachability probe
// ---------------------------------------------------------------------------

export type RpcProbeOutcome = 'ok' | 'wrong-chain' | 'unreachable' | 'bad-response' | 'timeout';
export type RpcProbeResult = { outcome: RpcProbeOutcome; chainId?: number };

/** JSON-RPC hex quantity, per spec: 0x-prefixed, no leading zeros beyond "0x0". */
function parseChainIdResult(result: unknown): number | undefined {
  if (typeof result !== 'string' || !/^0x[0-9a-f]+$/i.test(result)) return undefined;
  const parsed = Number.parseInt(result, 16);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Ask an endpoint which chain it serves, once, before we commit to it.
 *
 * This matters more with a row per chain than it did with one field: the
 * mistake the form invites is pasting a mainnet URL into the Base row, and
 * without this the user finds out after the reload, as a chain that shows no
 * balance. "Your funds are gone" is the worst possible way to learn about a
 * typo, even when nothing is actually lost.
 *
 * Called on SAVE only, never per keystroke: an endpoint should not learn that
 * someone is typing its address. `credentials: 'omit'` and no referrer, so it
 * learns nothing but the request itself, which it is about to receive anyway.
 *
 * `fetchImpl` and `timeoutMs` are injected so the outcomes are testable
 * without a network.
 */
export async function probeRpcUrl(
  url: string,
  expectedChainId: number,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<RpcProbeResult> {
  const doFetch = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  if (!doFetch) return { outcome: 'unreachable' };
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, opts.timeoutMs ?? 5_000);
  try {
    const response = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: controller.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) return { outcome: 'bad-response' };
    const body = (await response.json()) as { result?: unknown };
    const chainId = parseChainIdResult(body?.result);
    if (chainId === undefined) return { outcome: 'bad-response' };
    return chainId === expectedChainId ? { outcome: 'ok', chainId } : { outcome: 'wrong-chain', chainId };
  } catch {
    // The timer is cleared in `finally`, so a slow-drip body read aborts too.
    return { outcome: timedOut ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/** What the form says for each outcome. One sentence, no em dashes. */
export const RPC_PROBE_MESSAGES: Readonly<Record<Exclude<RpcProbeOutcome, 'ok'>, string>> = {
  'wrong-chain': 'That endpoint reports a different network.',
  unreachable: 'Could not reach that endpoint.',
  'bad-response': 'That endpoint did not answer like an RPC node.',
  timeout: 'That endpoint did not answer in time.',
};

/**
 * Which chains may be queried, once the user has an endpoint of their own.
 *
 * An account-key session sweeps every EVM chain (sdk-provider `syncAllChains`),
 * and the override is per chain, so setting one endpoint used to leave every
 * other chain's queries going to the defaults. ppv2's defaults are not a proxy
 * of ours the way v1's are, they are Alchemy on our key plus public nodes, but
 * the shape is the same: someone who names their own endpoint is still handing
 * the rest of their scan to a third party on our account, and nothing says so.
 *
 * Set none and nothing changes, the defaults serve everything. Set ONE and the
 * rule flips: chains without an endpoint are not queried at all.
 *
 * The cost is deliberate and it is why the form names the skipped chains before
 * the user saves. Notes on a skipped chain stop appearing until an endpoint is
 * set for it, and clearing every endpoint restores the old behaviour.
 *
 * PURE, and takes the map rather than reading it, so the sweep and the warning
 * cannot disagree about which chains are in play.
 */
export function queryableChainIds(
  allChainIds: readonly number[],
  overrides: CustomRpcOverrides,
): number[] {
  if (Object.keys(overrides).length === 0) return [...allChainIds];
  return allChainIds.filter((chainId) => !!customRpcUrlFor(overrides, chainId));
}

/** The other half of the same split, for telling the user what they lose. */
export function skippedChainIds(
  allChainIds: readonly number[],
  overrides: CustomRpcOverrides,
): number[] {
  if (Object.keys(overrides).length === 0) return [];
  return allChainIds.filter((chainId) => !customRpcUrlFor(overrides, chainId));
}
