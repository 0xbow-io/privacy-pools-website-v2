/**
 * Relayed keystore registration ("cold start") — per-chain capability data.
 *
 * PURE module (no react-native imports) so bun tests and node tooling can
 * import it directly, same contract as config/relayer-eras.ts.
 *
 * The flow: a brand-new wallet holding no gas can still cash out a note it
 * received. It signs an EIP-712 `SetAuthPolicy` off-chain (free — a signature,
 * not a transaction) and the relayer posts
 * `PrivacyPoolRelay.registerAndRelay`, which runs
 * `Keystore.setAuthPolicyWithSig` and the withdrawal in ONE transaction. The
 * relayer's fee is taken out of the withdrawn note, so the wallet never needs
 * to hold native currency at all.
 *
 * That needs three things live at the same time, and two of them are
 * deployment facts no cheap runtime probe can establish:
 *   1. the relayer serving `POST /v1/relay/evm/<chainId>/register-and-withdrawal`
 *      — the `relayer-v2-testing` build has it, `relayer-v2-staging` does not;
 *   2. `registerAndRelay` on the chain's PrivacyPoolRelay;
 *   3. `setAuthPolicyWithSig` on the chain's Keystore.
 *
 * So this is an ALLOW-LIST keyed by `chainId → PrivacyPoolRelay[]`, each entry
 * verified by reading the deployed bytecode for those selectors (2026-08-18):
 *
 *   chain 1     relay 0xeD30CB5e… ✅   keystore 0x08806e1a… ✅   (staging)
 *   chain 4114  relay 0x224fD8EB… ✅   keystore 0x8240695D… ✅   (staging)
 *   chain 10    relay 0x55DC6ADe… ✅   keystore 0x4BeCb4c0… ✅   (staging, 2026-08-20)
 *   chain 1, 4114, 56   relay 0x01a8Fa4d… ✅   keystore 0x6E463391… ✅   (PROD, 2026-09-02:
 *     the relay bytecode carries 0xaaa7a340 and is byte-identical on all three
 *     chains; the keystore impl behind pool.keystore(), 0x7b915008…, carries
 *     0xe6c97c2b; the prod relayer answers the register-and-withdrawal route
 *     with field validation on all three.)
 *
 * A chain can carry SEVERAL verified relays because prod and staging deploy
 * different pools on the same chain ids (1, 4114, 56); the environment switch
 * (config/app-environment.ts) decides which one the app binds to, and this
 * list only has to recognise it.
 *
 * Deliberately absent:
 *   - Sepolia (11155111): the relayer route is live, but BOTH deployed relays
 *     (V9 0x762665Dc…, V8 0x87a5BFbA…) and both keystores (0x5b8883a2…,
 *     0x6d264aCb…) predate the feature and carry neither selector. A claim
 *     would die inside the relayer's `simulateContract`, after the user had
 *     already signed and paid for ~15s of proving. Add it via the env override
 *     below (or here) once relay + keystore are redeployed.
 *
 * Optimism (10) was in this list of absentees until 2026-08-20, when all three
 * conditions were re-checked and held: the relayer answers
 * `POST /v1/relay/evm/10/register-and-withdrawal` with field validation (same
 * response as chain 1, not a 404 or "config not found"); the published relay
 * 0x55DC6ADe… carries `registerAndRelay` (0xaaa7a340) in bytecode byte-identical
 * in length to chain 1's verified relay, and its `POOL()` is the OP pool; and the
 * keystore impl behind 0x4BeCb4c0… (which `pool.keystore()` returns) carries
 * `setAuthPolicyWithSig` (0xe6c97c2b).
 *
 * The relay address is half the key on purpose. Pool-era switching
 * (config/relayer-eras.ts) can point the app at an OLDER relay on the same
 * chain, and an older relay does not carry `registerAndRelay`. Keying on
 * chainId alone would offer a gasless claim that always reverts.
 */

/** The prod PrivacyPoolRelay (same address on chains 1, 4114 and 56). */
const PROD_COLD_START_RELAY = '0x01a8Fa4dbb60187aD8d3c3d08E7Fb8C14198A461';

/** `chainId → PrivacyPoolRelay[]` verified to implement `registerAndRelay`. */
export const VERIFIED_COLD_START_RELAYS: Readonly<Record<number, readonly string[]>> = {
  1: ['0xeD30CB5e05684b0C3C6345c990576607F070A7b4', PROD_COLD_START_RELAY],
  4114: ['0x224fD8EB6b7bE6D23189CC22dd04DD7E7aCD59Fd', PROD_COLD_START_RELAY],
  10: ['0x55DC6ADe57F3243c659cFe045F591C011924fECc'],
  56: [PROD_COLD_START_RELAY],
};

/**
 * Parses `EXPO_PUBLIC_COLD_START_CLAIM_RELAYS` — comma-separated
 * `chainId:relayAddress` pairs, e.g.
 * `"11155111:0xAbC…,10:0xDeF…"`. Lets ops light up a chain right after a
 * redeploy without shipping code. Entries ADD to (and override)
 * {@link VERIFIED_COLD_START_RELAYS}. Malformed pairs are dropped rather than
 * throwing: a typo must not take the whole build down, and dropping one keeps
 * the feature fail-closed for that chain.
 */
export function parseColdStartRelayOverride(raw: string | undefined): Record<number, string> {
  const out: Record<number, string> = {};
  if (!raw) return out;
  for (const entry of raw.split(',')) {
    const [rawChainId, rawAddress] = entry.split(':');
    const chainId = Number(rawChainId?.trim());
    const address = rawAddress?.trim();
    if (!Number.isInteger(chainId) || chainId <= 0) continue;
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) continue;
    // The zero address would key the allow-list to an impossible relay.
    if (/^0x0{40}$/.test(address)) continue;
    out[chainId] = address;
  }
  return out;
}

/**
 * Whether a gasless relayed claim can be offered on `chainId` while the app is
 * bound to `relayAddress` (the WITHDRAWAL proof processor —
 * `getWithdrawalProcessorAddress(chainId)`).
 *
 * Fail-closed: an unknown chain, a missing relay, or a relay that is not the
 * verified one for that chain all return false, which leaves the user on the
 * existing self-funded registration path.
 */
export function supportsColdStartClaim(
  chainId: number,
  relayAddress: string | undefined,
  overrideRaw?: string,
): boolean {
  if (!relayAddress) return false;
  // An env override for the chain REPLACES its verified list (ops pointing a
  // chain at a just-redeployed relay); otherwise any verified relay matches.
  const override = parseColdStartRelayOverride(overrideRaw)[chainId];
  const verified = override ? [override] : (VERIFIED_COLD_START_RELAYS[chainId] ?? []);
  const wanted = relayAddress.trim().toLowerCase();
  return verified.some((relay) => relay.toLowerCase() === wanted);
}

/**
 * Chains where relayed registrations request `extraGas`, so the wallet can pay
 * for `setViewingKey` (which only it can send). The relayer caps the top-up at
 * its `max_native_gas_wei`, which must cover that transaction.
 */
export const REGISTRATION_GAS_TOP_UP_CHAINS: readonly number[] = [1, 56, 4114];

/** Env override: replaces the default; empty or `none` disables. */
export function parseRegistrationTopUpChains(raw: string | undefined): readonly number[] {
  if (raw === undefined) return REGISTRATION_GAS_TOP_UP_CHAINS;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'none') return [];
  const out: number[] = [];
  for (const entry of trimmed.split(',')) {
    const chainId = Number(entry.trim());
    if (Number.isInteger(chainId) && chainId > 0 && !out.includes(chainId)) out.push(chainId);
  }
  return out;
}

export function registrationTopUpEnabled(chainId: number, overrideRaw?: string): boolean {
  return parseRegistrationTopUpChains(overrideRaw).includes(chainId);
}
