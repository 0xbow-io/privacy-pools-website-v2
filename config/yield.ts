// Aave yield module (ppUSDC) — frontend configuration.
//
// ─────────────────────────────────────────────────────────────────────────
// ENABLEMENT CHECKLIST — do NOT set EXPO_PUBLIC_YIELD_ENABLED=true in any
// user-facing deployment until every required box is ticked. A yield deposit
// converts USDC into a shielded ppUSDC share note. "Withdraw-ready" currently
// means the share note can be withdrawn as the share token and the UI says so.
// It does not mean the app redeems ppUSDC to USDC through PPRouter.
//
//   [ ] A real (non-fork) yield deployment exists and is supplied via
//       EXPO_PUBLIC_YIELD_DEPLOYMENT_JSON (the SDK ships none — YIELD_DEPLOYMENTS
//       is empty by design).
//   [ ] ppUSDC notes are modelled as a distinct asset that is presented under
//       its underlying (USDC) and valued via previewRedeem, so the deposited
//       principal shows up in the USDC balance rather than a phantom pool.
//   [x] ppUSDC shares are selectable in the ordinary Withdraw and Send paths.
//       Withdraw pays the recipient in ppUSDC, and every payout/review/receipt
//       surface names ppUSDC rather than promising USDC redemption. This is
//       what EXPO_PUBLIC_YIELD_WITHDRAW_READY=true asserts today.
//   [ ] Before claiming an in-app underlying exit, verify that the production
//       relayer accepts PPRouter as processor, then wire session.yieldFor(share)
//       prepareYieldWithdraw / prepareYieldWithdrawRelay end to end.
//   [ ] Per-note deposit cost basis (underlyingNeeded) is persisted so accrued
//       yield can be shown as a real split instead of total redeemable value.
//       (Blocks the "earned to date" slot in the yield card / portfolio stats.)
//       PARTIAL: the PUBLIC half now exists behind asp-v2 PR #90 (issue #89) —
//       GET /:chainId/public/yield-deposits serves gross underlying + note
//       shares + vetting-fee shares per output commitment. Still missing (and
//       NOT built): the local join of the wallet's own commitments against that
//       feed plus wallet-side lineage for change notes (received notes have no
//       basis by construction).
//   [~] Live APY — the REAL source now exists behind asp-v2 PR #90 (issue #89):
//       GET /:chainId/public/ppusdc-vault-metrics returns the NET ppUSDC
//       REALIZED APY (annualized exchangeRate growth, after the protocol yield
//       fee) plus a DERIVED GROSS Aave supply APY (gross = net / (1 − feeBps)) —
//       the two are NOT interchangeable. hooks/use-yield-feeds.ts
//       (useResolvedYieldApy) prefers the feed's NET figure and falls back to
//       EXPO_PUBLIC_YIELD_APY, then to omitted. The feeds are config-gated
//       dormant server-side (404 until a yield pool is configured), so this
//       static placeholder is still what ships today; the box ticks when the PR
//       merges AND the pool is configured — no frontend change needed.
//       The historical series is likewise real when the feeds answer:
//       /:chainId/public/ppusdc-rate-history exchangeRate deltas drive the
//       per-row chart in components/portfolio/all-positions.tsx, which says
//       the history is unavailable otherwise.
//   [ ] The Q1 opt-out fee is decided AND enforced on-chain before
//       EXPO_PUBLIC_YIELD_OPT_OUT_FEE_ENFORCED is set (never advertise a fee no
//       transaction charges).
//
// getYieldDeploymentForChain() below is the SINGLE gate the whole feature
// (UI + PoolSessionConfig.yieldDeployment) reads. It fails closed: master flag
// OFF, deployment missing/invalid, OR withdraw-not-ready → undefined.
// ─────────────────────────────────────────────────────────────────────────

import type { YieldDeployment } from '@/services/sdk-types';
import { ACTIVE_ENVIRONMENT } from '@/config/environments';
import { yieldVaultUsable } from '@/services/yield-vault-probe';

function getEnv(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value && value.trim().length > 0)?.trim();
}

// IMPORTANT: read each flag via a STATIC `process.env.EXPO_PUBLIC_*` member
// expression. Expo/Metro only inlines static member access at build time; a
// dynamic `process.env[name]` lookup is NOT inlined and resolves to `undefined`
// in the production web export (it silently "works" only in local dev, where
// process.env is live). See config/sui-deployment.ts for the same warning.
function toBool(value: string | undefined): boolean {
  return value?.toLowerCase() === 'true';
}

/** Master switch for the whole Aave-yield UI + SDK wiring. Default OFF. */
export const YIELD_ENABLED = toBool(process.env.EXPO_PUBLIC_YIELD_ENABLED);

/**
 * Hard-block for the deposit-exit risk. Default OFF. Flipping it promises that
 * share notes are modelled as shares, can leave through ordinary Withdraw/Send,
 * and every exit surface says the payout is the share token. It does not claim
 * that this app redeems the share to its underlying (see the checklist above).
 */
export const YIELD_WITHDRAW_READY = toBool(process.env.EXPO_PUBLIC_YIELD_WITHDRAW_READY);

/**
 * The FullWithdrawalGuard is a GENERAL privacy warning (linking a full
 * withdrawal to a deposit), not an Aave-yield concern — Mike grouped it with
 * the yield task, but it must not ride the yield master flag (codex finding 8:
 * never consume YIELD_ENABLED for non-yield behaviour). Its own flag.
 *
 * Default ON (owner decision, 2026-08-27): the guard is a privacy protection,
 * so it must not depend on every deployment remembering an env var. Set
 * EXPO_PUBLIC_FULL_WITHDRAWAL_GUARD=false to switch it off explicitly.
 */
export const FULL_WITHDRAWAL_GUARD_ENABLED =
  process.env.EXPO_PUBLIC_FULL_WITHDRAWAL_GUARD === undefined
    ? true
    : toBool(process.env.EXPO_PUBLIC_FULL_WITHDRAWAL_GUARD);

// Live APY: the real source is the public ppUSDC vault-metrics feed (asp-v2 PR
// #90 / issue #89), consumed via hooks/use-yield-feeds.ts. This module stays
// PURE + STATIC on purpose (it is imported from Bun generator contexts — never
// add react/react-query imports here), so the feed-vs-placeholder resolution
// lives in that hook, not below. The value below is the FALLBACK the hook uses
// while the feeds are dormant (they 404 until a yield pool is configured).
//
// POLICY (codex P2, applied to EVERY surface that shows an APY): an
// UNCONFIGURED APY is UNAVAILABLE (null) and the number is omitted — the
// yield card / pool header chip / home pools chip / deposit modal render
// their labels without a percentage. When the feed IS live, the figure shown is
// the NET ppUSDC REALIZED APY and must be labelled as such — never swapped for
// the derived GROSS Aave supply APY (gross = net / (1 − feeBps)). There is no
// fabricated fallback anywhere. Never reintroduce a silent numeric default here.

/** Pure parser (unit-tested): env string → APY percent, or null = unavailable. */
export function parseApyPercent(raw: string | undefined): number | null {
  const trimmed = getEnv(raw);
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Configured APY percent, or null when unconfigured/invalid (omit the number). */
export const YIELD_APY_PERCENT: number | null = parseApyPercent(process.env.EXPO_PUBLIC_YIELD_APY);

// TODO(yield-Q1): the opt-out fee model is UNDECIDED (Railgun-style, Mike's Q1).
// This is the ONE constant to change when it's decided — a flat fee in the
// deposit asset's units, added to Total Cost when the user opts OUT. Default 0.
export const YIELD_OPT_OUT_FEE: number = (() => {
  const raw = getEnv(process.env.EXPO_PUBLIC_YIELD_OPT_OUT_FEE);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
})();

/**
 * Whether the opt-out fee is actually charged on-chain. Until a transaction
 * enforces it, the UI must NOT advertise it (codex finding 4). Default OFF, so
 * the fee row/total addition stay hidden even if YIELD_OPT_OUT_FEE is set.
 */
export const YIELD_OPT_OUT_FEE_ENFORCED = toBool(process.env.EXPO_PUBLIC_YIELD_OPT_OUT_FEE_ENFORCED);

/** True only when a non-zero opt-out fee is BOTH configured and enforced. */
export function yieldOptOutFeeActive(): boolean {
  return YIELD_OPT_OUT_FEE_ENFORCED && YIELD_OPT_OUT_FEE > 0;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function isRealAddress(value: unknown): value is string {
  return typeof value === 'string'
    && ADDRESS_RE.test(value)
    && value.toLowerCase() !== ZERO_ADDRESS;
}

// ERC-20 decimals live in a byte; anything outside a sane range is a typo. We
// additionally bound the ppUSDC↔underlying gap so the bigint exponentiation in
// use-accrued-yield can never blow up the render (codex finding 9).
function isSaneDecimals(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 36;
}

/**
 * Parses the env-supplied chainId → YieldDeployment map. Pure (testable);
 * malformed JSON or entries fail CLOSED (dropped with a warning) so a typo'd
 * env can never route funds at a half-configured router. Rejects the zero
 * address, out-of-range decimals, and an unreasonable decimal gap.
 */
function parseOneYieldDeployment(chainKey: string, value: unknown): YieldDeployment | null {
  const chainId = Number(chainKey);
  const d = value as Partial<YieldDeployment> | null;
  const decimalsOk = !!d
    && isSaneDecimals(d.ppUSDCDecimals)
    && isSaneDecimals(d.underlyingDecimals)
    && (d.ppUSDCDecimals as number) >= (d.underlyingDecimals as number)
    && (d.ppUSDCDecimals as number) - (d.underlyingDecimals as number) <= 30;
  // NATIVE_MODE is only coherent over a wrapped-native underlying, which is
  // 18 decimals on every chain we serve, and the production ppETH wrapper sits
  // at decimals offset 0 (18-dp share over an 18-dp underlying). Anything else
  // claiming nativeMode is a mis-copied ppUSDC entry, and routing msg.value at
  // it would be funding a router that cannot wrap. Fail closed like the rest.
  const nativeModeOk = d?.nativeMode === undefined
    || (typeof d.nativeMode === 'boolean'
      && (d.nativeMode === false
        || (d.underlyingDecimals === 18 && d.ppUSDCDecimals === 18)));
  const valid =
    Number.isSafeInteger(chainId)
    && chainId > 0
    && !!d
    && isRealAddress(d.ppRouter)
    && isRealAddress(d.ppUSDC)
    && isRealAddress(d.underlying)
    && decimalsOk
    && typeof d.underlyingSymbol === 'string' && d.underlyingSymbol.length > 0
    && (d.zap === undefined || isRealAddress(d.zap))
    && nativeModeOk;
  if (!valid) {
    console.warn(`[yield] Ignoring invalid yield deployment for chain "${chainKey}".`);
    return null;
  }
  return {
    ppRouter: d!.ppRouter as YieldDeployment['ppRouter'],
    ppUSDC: d!.ppUSDC as YieldDeployment['ppUSDC'],
    ppUSDCDecimals: d!.ppUSDCDecimals as number,
    underlying: d!.underlying as YieldDeployment['underlying'],
    underlyingDecimals: d!.underlyingDecimals as number,
    underlyingSymbol: d!.underlyingSymbol as string,
    ...(isRealAddress(d!.zap) ? { zap: d!.zap as YieldDeployment['zap'] } : {}),
    ...(d!.nativeMode === true ? { nativeMode: true as const } : {}),
    ...(typeof d!.apyLabel === 'string' ? { apyLabel: d!.apyLabel } : {}),
  };
}

/**
 * chainId → EVERY yield deployment on that chain. A chain may carry one object
 * (the original shape) or an array (mainnet: ppUSDC over aUSDC AND ppUSDT over
 * aUSDT, 2026-09-04). Entries are validated one by one and fail closed
 * individually; a second entry naming the same share token is dropped with a
 * warning, never silently preferred.
 */
export function parseYieldDeploymentsMap(
  json: string | undefined,
): Record<number, YieldDeployment[]> {
  if (!json || json.trim().length === 0) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    console.warn('[yield] EXPO_PUBLIC_YIELD_DEPLOYMENT_JSON is not valid JSON. Yield disabled.');
    return {};
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Record<number, YieldDeployment[]> = {};
  // Uniqueness is per NORMALIZED chain ("1" and "01" are one chain) and covers
  // both the share and the underlying: two deployments claiming the same
  // underlying would make "the deployment for USDC" an ordering accident.
  const seenShares = new Map<number, Set<string>>();
  const seenUnderlyings = new Map<number, Set<string>>();
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      const parsed = parseOneYieldDeployment(key, entry);
      if (!parsed) continue;
      const chainId = Number(key);
      const shares = seenShares.get(chainId) ?? new Set<string>();
      const underlyings = seenUnderlyings.get(chainId) ?? new Set<string>();
      const share = parsed.ppUSDC.toLowerCase();
      const underlying = parsed.underlying.toLowerCase();
      if (shares.has(share)) {
        console.warn(`[yield] Duplicate yield deployment for share ${parsed.ppUSDC} on chain ${chainId} ignored.`);
        continue;
      }
      if (underlyings.has(underlying)) {
        console.warn(`[yield] Second yield deployment for underlying ${parsed.underlying} on chain ${chainId} ignored.`);
        continue;
      }
      shares.add(share); underlyings.add(underlying);
      seenShares.set(chainId, shares); seenUnderlyings.set(chainId, underlyings);
      (out[chainId] ??= []).push(parsed);
    }
  }
  return out;
}

/** The FIRST deployment per chain: the original single-deployment view of the same env. */
export function parseYieldDeploymentMap(
  json: string | undefined,
): Record<number, YieldDeployment> {
  const out: Record<number, YieldDeployment> = {};
  for (const [chainId, list] of Object.entries(parseYieldDeploymentsMap(json))) {
    if (list[0]) out[Number(chainId)] = list[0];
  }
  return out;
}

/** All of a chain's deployments, flags-gated (see resolveYieldDeployment). */
export function resolveYieldDeployments(
  chainId: number,
  opts: { enabled: boolean; withdrawReady: boolean },
  deployments: Record<number, YieldDeployment[]>,
): YieldDeployment[] {
  if (!opts.enabled || !opts.withdrawReady) return [];
  return deployments[chainId] ?? [];
}

/**
 * The verified deployment serving `tokenAddress` on `chainId`: its underlying
 * (the asset a user deposits) or its share (the asset a note is held in).
 * Pure; `usable` is the per-share vault verdict.
 */
export function resolveYieldDeploymentForAsset(
  chainId: number,
  tokenAddress: string | undefined,
  opts: { enabled: boolean; withdrawReady: boolean },
  deployments: Record<number, YieldDeployment[]>,
  usable: (chainId: number, share: string) => boolean,
): YieldDeployment | undefined {
  if (!tokenAddress) return undefined;
  const key = tokenAddress.toLowerCase();
  return resolveYieldDeployments(chainId, opts, deployments).find(
    (d) => usable(chainId, d.ppUSDC)
      && (d.underlying.toLowerCase() === key || d.ppUSDC.toLowerCase() === key),
  );
}

/**
 * The verified deployment only when `tokenAddress` is its underlying input.
 * A share address must return undefined: ppUSDC is already an Entrypoint asset
 * and depositing it through PPRouter would wrongly treat 18-decimal shares as
 * 6-decimal underlying.
 */
export function resolveYieldDepositDeploymentForUnderlying(
  chainId: number,
  tokenAddress: string | undefined,
  opts: { enabled: boolean; withdrawReady: boolean },
  deployments: Record<number, YieldDeployment[]>,
  usable: (chainId: number, share: string) => boolean,
): YieldDeployment | undefined {
  if (!tokenAddress) return undefined;
  const key = tokenAddress.toLowerCase();
  return resolveYieldDeployments(chainId, opts, deployments).find(
    (d) => usable(chainId, d.ppUSDC) && d.underlying.toLowerCase() === key,
  );
}

/**
 * Pure resolver. Fails closed unless the master flag is on, a valid deployment
 * exists for the chain, AND the share-token withdraw path is ready, so enabling
 * the flag without a usable share-note exit cannot surface a deposit path.
 */
export function resolveYieldDeployment(
  chainId: number,
  opts: { enabled: boolean; withdrawReady: boolean },
  deployments: Record<number, YieldDeployment>,
): YieldDeployment | undefined {
  if (!opts.enabled || !opts.withdrawReady) return undefined;
  return deployments[chainId];
}

/**
 * resolveYieldDeployment plus the one check an env var cannot fake: the vault
 * has been seen to have bytecode on chain. Kept separate from
 * resolveYieldDeployment (which stays a pure flags gate) so the two questions
 * can be tested apart, and so the probe site can ask the first without the
 * second.
 */
export function resolveVerifiedYieldDeployment(
  chainId: number,
  opts: { enabled: boolean; withdrawReady: boolean; vaultVerified: boolean },
  deployments: Record<number, YieldDeployment>,
): YieldDeployment | undefined {
  if (!opts.vaultVerified) return undefined;
  return resolveYieldDeployment(chainId, opts, deployments);
}

/** Per chain: the env JSON's entry when it names the chain, else the environment's code default. */
export function mergeYieldDeploymentMaps(
  defaults: Record<number, YieldDeployment[]> | undefined,
  fromEnv: Record<number, YieldDeployment[]>,
  /**
   * Chains whose code defaults are an audited allowlist (prod): an env entry
   * for such a chain is ignored unless it names the same router + share, so a
   * mistaken Vercel JSON can never become the production money route.
   */
  lockedChainIds: readonly number[] = [],
): Record<number, YieldDeployment[]> {
  const out: Record<number, YieldDeployment[]> = { ...(defaults ?? {}) };
  const sameSet = (a: YieldDeployment[], b: YieldDeployment[]) => a.length === b.length
    && a.every((x) => b.some((y) => y.ppRouter.toLowerCase() === x.ppRouter.toLowerCase() && y.ppUSDC.toLowerCase() === x.ppUSDC.toLowerCase()));
  for (const [key, list] of Object.entries(fromEnv)) {
    const chainId = Number(key);
    if (lockedChainIds.includes(chainId) && defaults?.[chainId]) {
      if (!sameSet(defaults[chainId], list)) {
        console.warn(`[yield] Ignoring EXPO_PUBLIC_YIELD_DEPLOYMENT_JSON for chain ${chainId}: prod routers are fixed in config/prod-deployments.ts.`);
      }
      continue;
    }
    out[chainId] = list;
  }
  return out;
}

// Code defaults (prod: the verified routers in config/prod-deployments.ts)
// merged with the env JSON PER CHAIN: a Vercel JSON that only names Sepolia's
// placeholder must not erase mainnet's and BSC's routers, and a chain the env
// does name is the operator's call. The master flags gate either source, so a
// deployment being KNOWN never turns yield on.
const YIELD_DEPLOYMENTS_MAP: Record<number, YieldDeployment[]> = mergeYieldDeploymentMaps(
  ACTIVE_ENVIRONMENT.yieldDeployments,
  parseYieldDeploymentsMap(process.env.EXPO_PUBLIC_YIELD_DEPLOYMENT_JSON),
  // Prod's routers are an allowlist (codex, 2026-09-04): the env can add chains
  // it does not cover, never repoint one it does.
  ACTIVE_ENVIRONMENT.id === 'prod' ? Object.keys(ACTIVE_ENVIRONMENT.yieldDeployments ?? {}).map(Number) : [],
);
const YIELD_DEPLOYMENT_MAP: Record<number, YieldDeployment> = Object.fromEntries(
  Object.entries(YIELD_DEPLOYMENTS_MAP).flatMap(([chainId, list]) => (list[0] ? [[Number(chainId), list[0]]] : [])),
);
const YIELD_FLAGS = { enabled: YIELD_ENABLED, withdrawReady: YIELD_WITHDRAW_READY };

/** Every deployment the env CONFIGURES for `chainId`, flags-gated, unverified. For the probe site only. */
export function getConfiguredYieldDeployments(chainId: number): YieldDeployment[] {
  return resolveYieldDeployments(chainId, YIELD_FLAGS, YIELD_DEPLOYMENTS_MAP);
}

/**
 * Every yield router pinned for `chainId`, lowercase, whatever the flags: the
 * feed still has to name a router's past withdrawals after a flag turns off.
 */
export function getPinnedYieldRouters(chainId: number): string[] {
  return (YIELD_DEPLOYMENTS_MAP[chainId] ?? []).map((d) => d.ppRouter.toLowerCase());
}

/**
 * Every yield deployment pinned for `chainId`, whatever the flags: a user holding
 * loose shares in their wallet must be able to unwrap them after a flag turns off.
 */
export function getPinnedYieldDeployments(chainId: number): YieldDeployment[] {
  return YIELD_DEPLOYMENTS_MAP[chainId] ?? [];
}

/** Every deployment on `chainId` whose vault has been verified on chain, in env order. */
export function getYieldDeploymentsForChain(chainId: number): YieldDeployment[] {
  return getConfiguredYieldDeployments(chainId).filter((d) => yieldVaultUsable(chainId, d.ppUSDC));
}

/**
 * The verified deployment for the asset the user is looking at: its underlying
 * (USDC, what gets deposited) or its share (ppUSDC, what a note is held in).
 * Use this for display/classification. Deposits must use the underlying-only
 * resolver below, because a share itself takes the plain Entrypoint path.
 */
export function getYieldDeploymentForAsset(chainId: number, tokenAddress: string | undefined): YieldDeployment | undefined {
  return resolveYieldDeploymentForAsset(chainId, tokenAddress, YIELD_FLAGS, YIELD_DEPLOYMENTS_MAP, yieldVaultUsable);
}

/**
 * NAMING ONLY, share side: the route this build configures for either end of a
 * pair (underlying or share), vault-unverified. Same contract as
 * getConfiguredYieldDepositDeploymentForUnderlying — it answers what an asset
 * IS, not whether money may move through it.
 */
export function getConfiguredYieldDeploymentForAsset(chainId: number, tokenAddress: string | undefined): YieldDeployment | undefined {
  return resolveYieldDeploymentForAsset(chainId, tokenAddress, YIELD_FLAGS, YIELD_DEPLOYMENTS_MAP, () => true);
}

/**
 * NAMING ONLY: the route this build CONFIGURES for an underlying, flags-gated
 * but NOT vault-verified. What it answers is "where do this asset's deposits
 * land", never "may we move money through it" — that stays
 * getYieldDepositDeploymentForUnderlying, and every send-time gate keeps using
 * it, so an unverified vault still refuses the deposit rather than routing
 * into it.
 *
 * It exists because the verified resolver was also driving the WORDS and the
 * destination: before the probe answered, a picker called mainnet USDC
 * "Deposits closed" and defaulted its destination somewhere else, on the very
 * screen where picking USDC deposits into ppUSDC (Pat, 2026-09-12). Same
 * shape as the Portfolio gate fixed on 2026-09-07: surfaces read the
 * configured route, money reads the verified one.
 */
export function getConfiguredYieldDepositDeploymentForUnderlying(chainId: number, tokenAddress: string | undefined): YieldDeployment | undefined {
  return resolveYieldDepositDeploymentForUnderlying(chainId, tokenAddress, YIELD_FLAGS, YIELD_DEPLOYMENTS_MAP, () => true);
}

/**
 * True when this build configures a share pool for `tokenAddress` on this
 * chain (USDC on mainnet, USDT on mainnet and BNB Chain today, and whatever
 * the table carries tomorrow). Vault-unverified, same contract as above.
 */
export function isConfiguredYieldUnderlying(chainId: number, tokenAddress: string | undefined): boolean {
  return getConfiguredYieldDepositDeploymentForUnderlying(chainId, tokenAddress) !== undefined;
}

/** Exact verified PPRouter route for a selected underlying deposit input. */
export function getYieldDepositDeploymentForUnderlying(chainId: number, tokenAddress: string | undefined): YieldDeployment | undefined {
  return resolveYieldDepositDeploymentForUnderlying(chainId, tokenAddress, YIELD_FLAGS, YIELD_DEPLOYMENTS_MAP, yieldVaultUsable);
}

/**
 * The deployment the env CONFIGURES for `chainId`, flags-gated only, with no
 * on-chain verification. For exactly one caller: the probe in
 * services/pool-session-service.ts, which has to know what to probe before
 * anything can be verified. Everything user-facing must use
 * getYieldDeploymentForChain instead; handing this to the SDK or the UI
 * recreates the Sepolia bug this split exists to prevent.
 */
export function getConfiguredYieldDeployment(chainId: number): YieldDeployment | undefined {
  return resolveYieldDeployment(
    chainId,
    { enabled: YIELD_ENABLED, withdrawReady: YIELD_WITHDRAW_READY },
    YIELD_DEPLOYMENT_MAP,
  );
}

/**
 * The yield deployment for `chainId`, or undefined when the feature is not
 * fully enabled for it. This single gate feeds BOTH the UI visibility checks
 * and `PoolSessionConfig.yieldDeployment`, so they can never disagree.
 *
 * Since 2026-09-02 it also requires the vault to have been VERIFIED on chain
 * (services/yield-vault-probe.ts). On the Sepolia preview the env named a
 * placeholder vault with no bytecode, this gate opened on the env alone, and
 * every USDC deposit was routed into a revert. An env var is a claim; bytecode
 * is a fact. Until the probe has recorded 'ok' this answers undefined, so the
 * deposit modal shows no yield toggle and shields plainly.
 */
/**
 * The FIRST verified deployment on the chain. Kept for the single-asset
 * consumers (portfolio, pool page, accrued yield); a deposit must use
 * getYieldDeploymentForAsset instead.
 */
export function getYieldDeploymentForChain(chainId: number): YieldDeployment | undefined {
  return getYieldDeploymentsForChain(chainId)[0];
}

/**
 * True when the fail-closed yield resolver is active for at least one of the
 * given chains. The Portfolio nav entry + page gate on this (same pattern as
 * every other yield UI): with yield fully off, the portfolio surface never
 * appears.
 */
export function yieldActiveForAnyChain(chainIds: readonly number[]): boolean {
  return chainIds.some((chainId) => getYieldDeploymentForChain(chainId) !== undefined);
}

/**
 * True when yield is CONFIGURED (master flags on, a deployment known) for at
 * least one of the given chains, before any vault probe has run. The Portfolio
 * surface (header entry + page gate) keys on THIS: keying on the verified
 * deployment (yieldActiveForAnyChain) meant the header's module-load constant
 * and the page's first render both ran before the fail-closed probe answered,
 * so the entry never rendered and /portfolio bounced home on prod (Matthew,
 * Pat, 2026-09-07). Whether a vault is usable stays a per-render, probe-driven
 * question inside the page.
 */
export function yieldConfiguredForAnyChain(chainIds: readonly number[]): boolean {
  return chainIds.some((chainId) => getConfiguredYieldDeployments(chainId).length > 0);
}

/** True when `tokenAddress` is the yield underlying (e.g. USDC) for `chainId`. */
export function isYieldUnderlying(chainId: number, tokenAddress: string | undefined): boolean {
  if (!tokenAddress) return false;
  const key = tokenAddress.toLowerCase();
  return getYieldDeploymentsForChain(chainId).some((d) => d.underlying.toLowerCase() === key);
}

// --- Native-mode (ppETH) routes -------------------------------------------
// A native-mode PPRouter takes the chain's native coin directly: msg.value is
// both the funding and the slippage ceiling, the router wraps it to WETH
// itself, and the unused remainder comes back in the same transaction. There
// is no approval on this path because there is no ERC-20 to approve.
//
// Everything else is the audited ERC-20 flow, so these resolvers are the plain
// ones filtered by the flag rather than a second pipeline: the master flags,
// the per-share bytecode + structural probe and the relayer-exit check all
// still apply, in that order. The only extra question is whether the ROUTER
// says NATIVE_MODE, which no env var can fake and which
// services/yield-vault-probe.ts asks on chain.

/** Pure: the verified native-mode deployment for a chain, if the env names one. */
export function resolveNativeYieldDepositDeployment(
  chainId: number,
  opts: { enabled: boolean; withdrawReady: boolean },
  deployments: Record<number, YieldDeployment[]>,
  usable: (chainId: number, share: string) => boolean,
): YieldDeployment | undefined {
  return resolveYieldDeployments(chainId, opts, deployments).find(
    (d) => d.nativeMode === true && usable(chainId, d.ppUSDC),
  );
}

/**
 * The verified native-mode route for `chainId` — what a native-coin deposit
 * would shield into. Undefined until the env names one AND its vault + router
 * pass the probe, so an unconfigured build behaves exactly as before.
 */
export function getNativeYieldDepositDeployment(chainId: number): YieldDeployment | undefined {
  return resolveNativeYieldDepositDeployment(chainId, YIELD_FLAGS, YIELD_DEPLOYMENTS_MAP, yieldVaultUsable);
}

/**
 * The native-mode route this build CONFIGURES for `chainId`, flags-gated only,
 * with no on-chain verification. For the static surfaces that must decide
 * before any probe can have run (config/environments.ts opening the mainnet ETH
 * row). Anything that moves money uses getNativeYieldDepositDeployment.
 */
export function getConfiguredNativeYieldDeployment(chainId: number): YieldDeployment | undefined {
  return resolveNativeYieldDepositDeployment(chainId, YIELD_FLAGS, YIELD_DEPLOYMENTS_MAP, () => true);
}

/** True when this build configures a native-coin yield route on `chainId`. */
export function nativeYieldConfigured(chainId: number): boolean {
  return getConfiguredNativeYieldDeployment(chainId) !== undefined;
}

/**
 * The CONFIGURED route a PAY token deposits through, for display and
 * classification: an ERC-20 by its underlying address, the chain's native coin
 * by the native-mode route (it has no ERC-20 underlying to look up, which is why
 * the picker said nothing about yield next to ETH while ppETH was open, Pat,
 * 2026-09-18). Undefined for a plain asset. Money paths use the verified
 * lookups, not this.
 */
export function getConfiguredDepositRouteForPayToken(
  chainId: number,
  token: { address: string; isNative: boolean },
): YieldDeployment | undefined {
  return token.isNative
    ? getConfiguredNativeYieldDeployment(chainId)
    : getConfiguredYieldDepositDeploymentForUnderlying(chainId, token.address);
}
