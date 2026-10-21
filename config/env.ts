import { alchemyHostFor, buildRpcOrder } from '@/config/rpc-order';
import { ActivePoolSelection } from '@/config/pool-profile';
import { ACTIVE_ENVIRONMENT } from '@/config/environments';

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function getHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
}

function getBooleanEnv(...values: Array<string | undefined>): boolean {
  return values.some((value) => value?.toLowerCase() === 'true');
}

function getEnv(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value && value.trim().length > 0)?.trim();
}

// Internal-only build tools. Defined in its own cycle-free module (this file
// imports pool-profile, which needs the same flag); re-exported here so the
// existing import site keeps working.
export { INTERNAL_TOOLS_ENABLED } from '@/config/internal-tools';

const rawAlchemyKey = getEnv(
  process.env.EXPO_PUBLIC_ALCHEMY_KEY,
  process.env.ALCHEMY_KEY,
);
const rawRpcUrl = getEnv(
  process.env.EXPO_PUBLIC_RPC_URL,
  process.env.RPC_URL,
);
const rawMainnetRpcUrl = getEnv(
  process.env.EXPO_PUBLIC_MAINNET_RPC_URL,
  process.env.MAINNET_RPC_URL,
);
const rawSepoliaRpcUrl = getEnv(
  process.env.EXPO_PUBLIC_SEPOLIA_RPC_URL,
  process.env.SEPOLIA_RPC_URL,
  rawRpcUrl,
);
const rawRpcFallbackUrl = getEnv(
  process.env.EXPO_PUBLIC_RPC_FALLBACK_URL,
  process.env.RPC_FALLBACK_URL,
);
const rawMainnetRpcFallbackUrl = getEnv(
  process.env.EXPO_PUBLIC_MAINNET_RPC_FALLBACK_URL,
  process.env.MAINNET_RPC_FALLBACK_URL,
  rawRpcFallbackUrl,
);
const rawSepoliaRpcFallbackUrl = getEnv(
  process.env.EXPO_PUBLIC_SEPOLIA_RPC_FALLBACK_URL,
  process.env.SEPOLIA_RPC_FALLBACK_URL,
  rawRpcFallbackUrl,
);
const rawEnsRpcUrl = getEnv(
  process.env.EXPO_PUBLIC_ENS_RPC_URL,
  process.env.ENS_RPC_URL,
);

// The ASP follows the active environment (config/environments.ts): the prod
// ASP in Prod, the dev ASP (or EXPO_PUBLIC_ASP_URL) in Staging. Both carry a
// default, so a build with no ASP var no longer throws at import time.
export const ASP_URL = normalizeBaseUrl(ACTIVE_ENVIRONMENT.aspUrl);
export const ASP_HOSTNAME = getHostname(ASP_URL);
// Per environment (config/environments.ts): the dev and prod ASPs serve
// different X25519 keys, so the legacy EXPO_PUBLIC_ASP_PUBLIC_KEY override
// applies to the staging world only; prod has its own variable.
export const ASP_PUBLIC_KEY = ACTIVE_ENVIRONMENT.aspPublicKey;
export const ALCHEMY_KEY = rawAlchemyKey;
// ENS resolution always starts on mainnet, even while the app operates on
// Sepolia. Keep the generic EXPO_PUBLIC_RPC_URL override on Sepolia so a
// Sepolia endpoint cannot accidentally back the mainnet ENS client.
/** Endpoint order and its rationale live in config/rpc-order.ts. */
export const MAINNET_RPC_URLS = buildRpcOrder(
  ALCHEMY_KEY,
  alchemyHostFor(1),
  rawMainnetRpcFallbackUrl,
  rawMainnetRpcUrl,
  'https://ethereum-rpc.publicnode.com',
);
export const SEPOLIA_RPC_URLS = buildRpcOrder(
  ALCHEMY_KEY,
  alchemyHostFor(11155111),
  rawSepoliaRpcFallbackUrl,
  rawSepoliaRpcUrl,
  'https://ethereum-sepolia-rpc.publicnode.com',
);
/** Primary endpoint. Callers that can fail over should use the *_URLS list. */
export const MAINNET_RPC_URL = MAINNET_RPC_URLS[0];
export const SEPOLIA_RPC_URL = SEPOLIA_RPC_URLS[0];
/**
 * Endpoint used ONLY for ENS resolution of counterparty addresses and names.
 *
 * Deliberately separate from MAINNET_RPC_URL. ENS lookups are keyed on the
 * address of the person the user is transacting with; sending them over the
 * same connection that carries pool queries lets one provider correlate
 * "this IP is looking up address X" with that IP's private-pool activity.
 * Splitting the endpoint splits the observer; it does not make the lookup
 * private (the ENS provider still learns the counterparty). Never point this
 * at the pool RPC. See docs/privacy-request-discipline.md.
 */
export const ENS_RPC_URL = rawEnsRpcUrl ?? 'https://ethereum-rpc.publicnode.com';
/**
 * Whether to resolve counterparty addresses/names through ENS at all.
 *
 * Defaults to OFF: the lookup names the counterparty to the ENS provider. Every
 * call site renders the raw address when the name is null, so nothing breaks.
 * Operators who accept the trade-off set EXPO_PUBLIC_ENS_RESOLUTION=true (and
 * should set EXPO_PUBLIC_ENS_RPC_URL to a provider distinct from the pool RPC).
 *
 * AGENTS: the off-default is a deliberate product decision (2026-08-26,
 * commits 9f8b2c0 + ebe017b) - do NOT add a default-true, flip it in an env
 * file, or bypass the flag at a call site. Guarded by
 * services/__tests__/no-targeted-reads.test.ts; see services/ens.ts.
 */
export const ENS_RESOLUTION_ENABLED = getBooleanEnv(
  process.env.EXPO_PUBLIC_ENS_RESOLUTION,
  process.env.ENS_RESOLUTION,
);
export const TEST_MODE = getBooleanEnv(
  process.env.EXPO_PUBLIC_TEST_MODE,
  process.env.TEST_MODE,
);
// Seedphrase-free embedded "smart wallet" onboarding (the app IS the wallet:
// a passkey-derived EOA signs locally, no external wallet). Preview, OFF by
// default. Mobile-first: see config/smart-wallet.ts → smartWalletActive(), which
// enables it on native always and on web only when this flag is set.
export const SMART_WALLET_ENABLED = getBooleanEnv(
  process.env.EXPO_PUBLIC_ENABLE_SMART_WALLET,
);
// Full-balance batch withdrawals: when a withdrawal needs more input notes
// than one proof supports (5), orchestrate N proofs + one atomic relayBatch
// via the SDK instead of erroring. OFF by default.
//
// Enablement checklist (all required before flipping this on):
//   1. The batch-capable PrivacyPoolRelay is deployed on the target chain and
//      exposes relayBatch + MAX_BATCH(). As of 2026-07-14 the deployed Sepolia
//      relay (0x762665Dc…) bytecode has neither selector.
//   2. The relayer serves POST /v1/quote|relay/<type>/<chain>/batch. As of
//      2026-07-14 the staging relayer 404s on both.
//   3. Processor binding: DONE in-app — the batch session advertises the
//      PrivacyPoolRelay contract as the proof processor (see
//      getBatchWithdrawSession + createRelayerInteractor). Verify a live
//      integration test confirms the bound processor is the deployed relay.
//   4. The relayer's committed batch-quote lifetime (QUOTE_EXPIRATION_MS) must
//      exceed worst-case MAX_BATCH proving + submission time. The default is
//      60s (relayer common.schemas) — far shorter than a multi-proof batch, so
//      a slow device would waste every proof on an expired commitment. Confirm
//      a batch-sized expiry is configured before enabling.
export const BATCH_WITHDRAWALS_ENABLED = getBooleanEnv(
  process.env.EXPO_PUBLIC_BATCH_WITHDRAWALS,
);
// Legacy, network-agnostic override. It has only ever pointed at a TESTNET node
// (that is what .env.example shipped), so it is scoped to testnet below rather
// than feeding both networks: otherwise a deployment that kept this variable and
// merely set EXPO_PUBLIC_SUI_NETWORK=mainnet would read balances from testnet
// while dapp-kit asked the wallet to sign for `sui:mainnet`. Per-network
// overrides win over it, exactly as EXPO_PUBLIC_SEPOLIA_RPC_URL wins over the
// generic EXPO_PUBLIC_RPC_URL above.
export const SUI_RPC_URL = getEnv(
  process.env.EXPO_PUBLIC_SUI_RPC_URL,
  process.env.SUI_RPC_URL,
);
const rawSuiTestnetRpcUrl = getEnv(
  process.env.EXPO_PUBLIC_SUI_TESTNET_RPC_URL,
  process.env.SUI_TESTNET_RPC_URL,
  SUI_RPC_URL,
);
const rawSuiMainnetRpcUrl = getEnv(
  process.env.EXPO_PUBLIC_SUI_MAINNET_RPC_URL,
  process.env.SUI_MAINNET_RPC_URL,
);
// Same precedence as the EVM URLs above: explicit override → Alchemy → public
// node. Alchemy is preferred, not merely nicer: the public Sui testnet node is
// pruned, so `suix_queryEvents` over the pool package fails with "Could not find
// the referenced transaction events". Note discovery and the LeavesInserted
// state reconstruction replay that event history, so on a pruned node balances
// and withdrawals cannot be rebuilt. Alchemy serves the full history.
// These are the single source of truth — config/sui.ts, config/chains.ts and
// components/sui-provider.tsx all read them rather than repeating a default.
export const SUI_TESTNET_RPC_URL = rawSuiTestnetRpcUrl
  ?? (ALCHEMY_KEY
    ? `https://sui-testnet.g.alchemy.com/v2/${ALCHEMY_KEY}`
    : 'https://sui-testnet-rpc.publicnode.com');
export const SUI_MAINNET_RPC_URL = rawSuiMainnetRpcUrl
  ?? (ALCHEMY_KEY
    ? `https://sui-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`
    : 'https://fullnode.mainnet.sui.io:443');
// Which Sui network the app talks to. Only an explicit "mainnet" selects
// mainnet; anything else (unset, typo, empty) resolves to testnet, so a
// misconfigured deploy can never silently point real funds at a mainnet pool.
// See config/sui.ts for what else must land before mainnet is actually usable.
export const SUI_NETWORK: 'testnet' | 'mainnet' =
  getEnv(process.env.EXPO_PUBLIC_SUI_NETWORK)?.toLowerCase() === 'mainnet'
    ? 'mainnet'
    : 'testnet';
export { APP_ORIGIN, V1_URL, WHITEPAPER_URL } from './site-urls';

// Base for generated share-link URLs (pay/, receive/, import-note/, verify/).
// EXPO_PUBLIC_PAY_URL_BASE wins. When unset it defaults to EXPO_PUBLIC_APP_ORIGIN
// if that is set, so production only needs the one origin variable (Pat,
// 2026-10-20). With neither set it falls back to the current origin: this is a
// client-only SPA (`web.output: "single"` in app.json), so `window` is always
// available at runtime and a Vercel preview shares links to itself rather
// than to production. Trailing slashes are stripped.
const PAY_URL_BASE_ENV =
  getEnv(process.env.EXPO_PUBLIC_PAY_URL_BASE) ?? getEnv(process.env.EXPO_PUBLIC_APP_ORIGIN);
export const PAY_URL_BASE = PAY_URL_BASE_ENV
  ? normalizeBaseUrl(PAY_URL_BASE_ENV)
  : (typeof window !== 'undefined' && window.location?.origin ? window.location.origin : undefined);

/**
 * Same value, read at CALL time. The constant above is captured when this
 * module is first imported, which in a shared test process is whichever test
 * file loads it first: the golden accounting CSV expected
 * "https://pay.example.test/verify/…" and CI produced "/verify/…" because
 * another file had imported config/env before the test set the variable
 * (2026-09-04). Metro inlines the static member access, so production sees the
 * build value either way.
 */
export function getPayUrlBase(): string | undefined {
  const fromEnv = getEnv(process.env.EXPO_PUBLIC_PAY_URL_BASE) ?? getEnv(process.env.EXPO_PUBLIC_APP_ORIGIN);
  return fromEnv ? normalizeBaseUrl(fromEnv) : PAY_URL_BASE;
}

// Sepolia (chainId 11155111) protocol contract addresses + scan floors.
// Env-driven so the client can be re-pointed at a new deployment without code
// edits — set the EXPO_PUBLIC_SEPOLIA_* vars to override. Defaults track the
// internal-testing "0xbow-v1" deploy (v2-monorepo sepolia-0xbow-v1.md).
// The entrypoint address is intentionally NOT here: it is resolved at runtime
// from the ASP /entrypoints API.
// V9 deployment (sepolia-deployment-v9.md) — the relayer moved to V9, so the
// frontend follows. Entrypoint auto-selects per pool because
// resolveEntrypointChainConfig matches the configured pool against /entrypoints.
//
// The in-app pool switcher (config/pool-profile.ts) can re-point the WHOLE
// app at any other pool the ASP lists — the pool/entrypoint/fromBlock come
// from the /entrypoints feed at selection time; only the keystore (absent
// from the feed) is mapped per known vault below, falling back to the
// current keystore for unmapped pools. Env overrides still win.
const SEPOLIA_DEFAULT_POOL = {
  // V9 (2026-05-31 redeploy)
  pool: '0x09b94d3127019298757a6ceeb7911922085f7c01',
  keystore: '0x6d264acb9c3a7a3105c29470afe2f5f1ec203c73',
  fromBlock: '10932483',
} as const;

// Keystore addresses for pools whose deployment used a different keystore
// than the current default — keyed by pool vault (lowercase).
const SEPOLIA_KEYSTORE_BY_VAULT: Record<string, string> = {
  // Pre-cutover V8 pool (poolId 1 in /entrypoints, entrypoint 0x3191ed61…)
  '0x4deceef285a24ca05999870887c895042731d7cb': '0x5b8883a2f8339560d8ebfeaabf93ce4e7056c4ca',
};

export const SEPOLIA_DEFAULT_POOL_ADDRESS = SEPOLIA_DEFAULT_POOL.pool;

const selectedVault = ActivePoolSelection?.poolVault.toLowerCase();

export const SEPOLIA_POOL_ADDRESS = getEnv(
  process.env.EXPO_PUBLIC_SEPOLIA_POOL_ADDRESS,
) ?? selectedVault ?? SEPOLIA_DEFAULT_POOL.pool;
export const SEPOLIA_KEYSTORE_ADDRESS = getEnv(
  process.env.EXPO_PUBLIC_SEPOLIA_KEYSTORE_ADDRESS,
) ?? (selectedVault ? (SEPOLIA_KEYSTORE_BY_VAULT[selectedVault] ?? SEPOLIA_DEFAULT_POOL.keystore) : SEPOLIA_DEFAULT_POOL.keystore);
// ASPRegistry contract (V9 deploy) — the v2.0 SDK's ASPClient anchors
// association-set leaves to its on-chain `latestASPRoot`. Default mirrors
// the SDK's DEPLOYMENTS constant.
export const SEPOLIA_ASP_REGISTRY_ADDRESS = getEnv(
  process.env.EXPO_PUBLIC_SEPOLIA_ASP_REGISTRY_ADDRESS,
) ?? '0x35d29efdcf067599ab4a53cf40229477f0b1ca9c';
export const SEPOLIA_FROM_BLOCK = BigInt(
  getEnv(process.env.EXPO_PUBLIC_SEPOLIA_FROM_BLOCK)
    ?? (ActivePoolSelection ? String(ActivePoolSelection.fromBlock) : SEPOLIA_DEFAULT_POOL.fromBlock),
);
export const SEPOLIA_KEYSTORE_FROM_BLOCK = BigInt(
  getEnv(process.env.EXPO_PUBLIC_SEPOLIA_KEYSTORE_FROM_BLOCK)
    ?? (ActivePoolSelection ? String(ActivePoolSelection.fromBlock) : SEPOLIA_DEFAULT_POOL.fromBlock),
);

// Legacy spend-out build defaults. These describe the pre-cutover
// Sepolia v6/v7 pool/keystore/entrypoint and the association-set
// Merkle tree id (305) that holds the historical leaves. Hardcoded
// because they describe frozen historical state — the OLD pool will
// never change. Every value can still be overridden via env if the
// guessed URL or addresses ever need updating.
// After the V9 cutover the "legacy build" is the last V8 prod build, forked to
// a stable branch (legacy-v8 @ 47022d5) so V8-pool depositors can still see and
// exit (ragequit) their funds. That deploy serves the V8 pool natively from its
// own env default — it does NOT enter "legacy mode" (its hostname differs from
// its own LEGACY_URL), so the DEFAULT_LEGACY_* pins below don't apply to it.
const DEFAULT_LEGACY_URL =
  'https://privacy-pools-website-v2-git-legacy-v8-0xbow.vercel.app';
const DEFAULT_LEGACY_MT_ID = 305;
const DEFAULT_LEGACY_ENTRYPOINT = '0x8445493038708311e55a526587d6ec4338377df0';
const DEFAULT_LEGACY_POOL = '0xc131a029e8096fd427c2c2fd489b77c80b21574a';
const DEFAULT_LEGACY_KEYSTORE = '0xbb52626b05aad8950c6e90397aef3c3cab7d9ed1';

// Pointer to the legacy spend-out URL. Doubles as the activation
// signal: legacy mode kicks in if and only if the build is currently
// being served from this hostname. The defaults make this work
// out-of-the-box on the assumed Vercel project naming; envs override
// only if the legacy URL or addresses ever need to change.
export const LEGACY_URL: string = normalizeBaseUrl(
  getEnv(process.env.EXPO_PUBLIC_LEGACY_URL) ?? DEFAULT_LEGACY_URL,
);

// Legacy spend-out build: the SAME defaults work for both Vercel
// projects. The address values are inert on the main URL and only
// take effect when the build is being served from LEGACY_URL — at
// which point chains.ts is overridden so spend proofs hit the OLD
// pool and ASP leaves come from /association-set/{mtId}/leaves.
function readLegacyConfig():
  | { mtId: number; entrypoint: string; pool: string; keystore: string }
  | undefined {
  // Hostname gate: only activate when serving from the legacy URL.
  // SSR / build / native — no window — never activates here.
  if (typeof window === 'undefined') return undefined;
  let legacyHostname: string;
  try {
    legacyHostname = new URL(LEGACY_URL).hostname;
  } catch {
    return undefined;
  }
  if (window.location?.hostname !== legacyHostname) return undefined;

  const rawMtId = getEnv(process.env.EXPO_PUBLIC_LEGACY_MT_ID);
  const rawEntrypoint = getEnv(process.env.EXPO_PUBLIC_LEGACY_ENTRYPOINT) ?? DEFAULT_LEGACY_ENTRYPOINT;
  const rawPool = getEnv(process.env.EXPO_PUBLIC_LEGACY_POOL) ?? DEFAULT_LEGACY_POOL;
  const rawKeystore = getEnv(process.env.EXPO_PUBLIC_LEGACY_KEYSTORE) ?? DEFAULT_LEGACY_KEYSTORE;

  const mtId = rawMtId && /^[1-9][0-9]*$/.test(rawMtId)
    ? Number.parseInt(rawMtId, 10)
    : DEFAULT_LEGACY_MT_ID;
  const isAddr = (v: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(v);
  if (!isAddr(rawEntrypoint) || !isAddr(rawPool) || !isAddr(rawKeystore)) {
    throw new Error(
      'Legacy URL is being served but at least one legacy address override is invalid. '
      + 'Each of EXPO_PUBLIC_LEGACY_ENTRYPOINT / _POOL / _KEYSTORE must be 0x + 40 hex chars.',
    );
  }
  return {
    mtId,
    entrypoint: rawEntrypoint.toLowerCase(),
    pool: rawPool.toLowerCase(),
    keystore: rawKeystore.toLowerCase(),
  };
}

export const LEGACY_CONFIG = readLegacyConfig();

/**
 * Sentry DSN for the `v2-app` project (the v2 app, privacypools.com).
 *
 * Defaulted in code rather than left to the deployment (Pat, 2026-09-11): an
 * env var that has to be set in Vercel is an env var that will be missing on
 * the deploy where it matters, and a reporter that silently reports nothing is
 * worse than no reporter, because you believe you are covered. A DSN is a
 * public ingest key, not a secret - it ships in the client bundle by design.
 *
 * The override still exists so a fork can point at its own project, and
 * `EXPO_PUBLIC_SENTRY_DSN=off` (or any non-URL value) turns reporting off.
 *
 * WHAT is reported is decided in services/error-reports-event.ts, not here.
 */
const DEFAULT_SENTRY_DSN =
  'https://726f836298b9ca112faf0ef1df603d91@o4509437312958464.ingest.us.sentry.io/4512068713840640';

export const SENTRY_DSN = ((): string | undefined => {
  const raw = getEnv(process.env.EXPO_PUBLIC_SENTRY_DSN) ?? DEFAULT_SENTRY_DSN;
  // A malformed value disables reporting instead of throwing at startup. The
  // reporter is never allowed to be the reason the app fails to boot.
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.username ? raw : undefined;
  } catch {
    return undefined;
  }
})();

/**
 * Optional build label for Sentry, e.g. the deploy's git sha. Purely ours; no
 * user data can reach it. Unset is fine - reports are still grouped by
 * message and environment.
 */
export const SENTRY_RELEASE = getEnv(process.env.EXPO_PUBLIC_SENTRY_RELEASE);
