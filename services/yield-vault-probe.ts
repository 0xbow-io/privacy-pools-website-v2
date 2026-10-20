// Does the configured yield vault actually exist on chain?
//
// Why this module exists (Pat, 2026-09-02, running I-b on the Sepolia preview):
// every USDC shield failed before sending, with viem reporting that
// previewDeposit(uint256) returned no data from
// 0x2222222222222222222222222222222222222222. That address is a placeholder
// with no bytecode. The preview's Vercel env had EXPO_PUBLIC_YIELD_ENABLED,
// EXPO_PUBLIC_YIELD_WITHDRAW_READY and a placeholder
// EXPO_PUBLIC_YIELD_DEPLOYMENT_JSON all set, so config/yield's single gate
// opened, the deposit modal's yieldOptIn defaulted to true, and a plain "Shield
// USDC" was routed into the yield path. The SDK's prepareYieldDeposit checks
// only that the amount is positive and then calls previewDeposit on whatever
// vault it was handed, so a codeless address surfaced as a raw viem revert at
// the worst possible moment. The yield module's own header forbids enabling it
// anywhere user-facing until the checklist is ticked; env var hygiene is not a
// guarantee, this is.
//
// The rule: a vault we cannot prove has bytecode is a vault we do not route
// money into. Both ppUSDC and ppRouter must have code. Anything else, including
// an RPC that will not answer, disables yield for that chain and the deposit
// falls back to a plain shield, which is exactly what the user asked for. That
// is fail-closed in the same sense the rest of config/yield.ts already is.
//
// Privacy: eth_getCode on a PUBLIC contract address taken from config. Not a
// note-derived value and not a relayed tx hash, so outside the class
// docs/privacy-request-discipline.md bans.
//
// Pure logic here so it is testable; CI runs only services/ and scripts/.

export type VaultProbeState = 'unverified' | 'ok' | 'missing' | 'unreachable';

/** Minimal shape of a yield deployment this probe needs. */
export type ProbeableYieldDeployment = { ppUSDC: string; ppRouter: string; nativeMode?: boolean };

/** An RPC read returning the bytecode at an address ('0x'/undefined when none). */
export type GetCode = (address: string) => Promise<string | undefined | null>;

/**
 * 'ok' only when EVERY address has real bytecode. viem returns undefined for an
 * address with no code and older clients return '0x'; both mean nothing is
 * deployed there. An empty list is 'missing', not 'ok': nothing verified is not
 * the same as everything verified.
 */
export function classifyVaultBytecode(codes: ReadonlyArray<string | undefined | null>): 'ok' | 'missing' {
  if (codes.length === 0) return 'missing';
  for (const c of codes) {
    if (typeof c !== 'string') return 'missing';
    const t = c.trim().toLowerCase();
    if (t === '' || t === '0x') return 'missing';
  }
  return 'ok';
}

// Keyed per (chain, share): a chain can carry several yield vaults (mainnet
// ppUSDC + ppUSDT), each verified on its own. A record without a share is the
// chain-wide legacy key, which every share on that chain inherits.
const state = new Map<string, VaultProbeState>();
const keyFor = (chainId: number, share?: string) => `${chainId}:${share ? share.toLowerCase() : '*'}`;
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  for (const cb of listeners) {
    try { cb(); } catch { /* a bad listener must not stop the others */ }
  }
}

/**
 * Current probe state; 'unverified' until a probe has run. With a share, that
 * vault's own verdict (falling back to a chain-wide record). Without one, the
 * chain-wide record, else 'ok' when any vault on the chain verified.
 */
export function yieldVaultProbeState(chainId: number, share?: string): VaultProbeState {
  if (share) {
    return state.get(keyFor(chainId, share)) ?? state.get(keyFor(chainId)) ?? 'unverified';
  }
  const chainWide = state.get(keyFor(chainId));
  if (chainWide) return chainWide;
  // No share named: 'ok' when any vault on the chain verified; otherwise the
  // verdict of the first probed vault (so a lone 'missing' still reads as such).
  let first: VaultProbeState | undefined;
  for (const [k, v] of state) {
    if (!k.startsWith(`${chainId}:`)) continue;
    if (v === 'ok') return 'ok';
    first ??= v;
  }
  return first ?? 'unverified';
}

/**
 * May the app route funds into this chain's yield vault?
 *
 * Only a positively verified vault says yes. 'unverified' is a no on purpose:
 * config/yield's gate must not open on the strength of an env var alone, which
 * is the exact failure this guards against. The probe runs during session
 * creation, before any deposit UI is reachable, so for a real deployment this
 * flips to true before it can matter.
 */
export function yieldVaultUsable(chainId: number, share?: string): boolean {
  return yieldVaultProbeState(chainId, share) === 'ok';
}

/** Record a probe outcome (per share when given) and wake subscribers (the deposit modal's memo). */
export function recordYieldVaultProbe(chainId: number, result: Exclude<VaultProbeState, 'unverified'>, share?: string): void {
  const k = keyFor(chainId, share);
  if (state.get(k) === result) return;
  state.set(k, result);
  notify();
}

/** Subscribe to probe changes. Returns the unsubscribe function. */
export function subscribeYieldVaultProbe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Monotonic counter, bumped on every recorded change; a cheap memo dependency. */
export function yieldVaultProbeVersion(): number {
  return version;
}

/**
 * Probe both vault contracts and record the verdict for `chainId`.
 *
 * An RPC failure records 'unreachable' rather than throwing: session creation
 * must not die because a yield probe could not complete, and 'unreachable' is
 * treated as not-usable by yieldVaultUsable, so the failure direction is still
 * closed. The two states are kept distinct so a log line can say which it was.
 */
/** What a router says about itself; compared against the deployment and the chain's pool. */
export type RouterFacts = {
  vault: string;
  entrypoint: string;
  poolVault: string;
  /**
   * PPRouter.NATIVE_MODE(). Absent when the caller could not read it (an older
   * router predating the getter, or a probe that did not ask) — which is why an
   * absent value can satisfy an ERC-20 deployment but never a native one.
   */
  nativeMode?: boolean;
};
export type ReadRouter = (router: string) => Promise<RouterFacts>;

/**
 * Pure: a router is the right one only if it wraps THIS share and deposits into
 * THIS chain's Entrypoint and PoolVault. Bytecode alone proved nothing about
 * where an approval to the router would send money (codex, 2026-09-04).
 */
export function routerMatches(
  facts: RouterFacts,
  deployment: ProbeableYieldDeployment,
  expected: { entrypoint: string; poolVault: string },
): boolean {
  const lc = (s: string) => s.toLowerCase();
  // The mode has to match in BOTH directions. A native-mode config over an
  // ERC-20 router would send msg.value at a function that does not exist; an
  // ERC-20 config over a native router would approve WETH and call the
  // non-payable entry, which works but is not the route the UI is describing.
  // An unreadable NATIVE_MODE is only tolerable for the ERC-20 shape, which is
  // what every router deployed before it existed is.
  const modeMatches = deployment.nativeMode === true
    ? facts.nativeMode === true
    : facts.nativeMode !== true;
  return modeMatches
    && lc(facts.vault) === lc(deployment.ppUSDC)
    && lc(facts.entrypoint) === lc(expected.entrypoint)
    && lc(facts.poolVault) === lc(expected.poolVault);
}

export async function probeYieldVault(
  chainId: number,
  deployment: ProbeableYieldDeployment,
  getCode: GetCode,
  structural?: { readRouter: ReadRouter; expected: { entrypoint: string; poolVault: string } },
): Promise<Exclude<VaultProbeState, 'unverified'>> {
  let verdict: Exclude<VaultProbeState, 'unverified'>;
  try {
    const codes = await Promise.all([getCode(deployment.ppUSDC), getCode(deployment.ppRouter)]);
    verdict = classifyVaultBytecode(codes);
    if (verdict === 'ok' && structural) {
      const facts = await structural.readRouter(deployment.ppRouter);
      if (!routerMatches(facts, deployment, structural.expected)) {
        console.warn(`[yield] Router ${deployment.ppRouter} on chain ${chainId} does not match its share / Entrypoint / PoolVault; yield disabled for it.`, facts);
        verdict = 'missing';
      }
    }
  } catch {
    verdict = 'unreachable';
  }
  recordYieldVaultProbe(chainId, verdict, deployment.ppUSDC);
  return verdict;
}

/** Tests only: forget every recorded probe. */
export function resetYieldVaultProbesForTests(): void {
  state.clear();
  listeners.clear();
  version = 0;
}
