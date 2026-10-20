// @ts-nocheck - talks to the real SDK dist (its builder's conflict-branded
// generics do not type against the repo's SDK shim, types/privacy-pools-v2-sdk.d.ts),
// like the other scripts/e2e runners.
//
// The cross-chain private swap, headless: shielded ETH on Optimism into a
// shielded USDC note on the destination, on the STAGING deployments, through the SDK
// and direct transactions instead of the UI. Same account, same deployments,
// same verdict as scripts/e2e/crosschain-swap.ts, without a browser or a dev
// server, so a run costs what the chain and the bridge cost and nothing else.
//
// The swap leg mirrors the app's flow 4 (services/swap-flows.ts
// runReshieldCrosschain, wired as components/swap-modal-provider.tsx does):
// estimate, destination deposit proof, relayer quote, the gross/net guards,
// relay. swap-flows itself cannot be imported here (it pulls React Native in
// transitively), so the guards are restated below and named after their
// originals.
//
// Steps: funds check -> keys -> sessions -> note discovery -> (bridge gas to
// the destination) -> (register on the destination / OP) -> (shield + ASP approval) -> swap ->
// delivery verdict. Every transaction is gated by the funds check, which runs
// before the first one.
//
// DRY_RUN=1 stops before the first transaction: funds check, key derivation,
// sessions, discovery, and a full quote (estimate, destination deposit proof,
// relayer quote). Nothing is signed on chain or relayed.
//
// E2E_DEST_ASSET=ppusdc lands the swap in the destination's ppUSDC yield SHARE
// instead of plain USDC: the destination deposit goes through the share's
// router (prepareYieldSwapDeposit, services/swap-flows.ts buildRedeposit's
// share branch) and the verdict looks for a ppUSDC share note. Base only.
//
// Env: E2E_PK (or DEV_PK in .env), EXPO_PUBLIC_ALCHEMY_KEY,
//   E2E_DEST_ASSET (usdc | ppusdc, default usdc),
//   E2E_XSWAP_AMOUNT (0.001, ppusdc 0.005), E2E_XSWAP_SHIELD (0.003, ppusdc 0.006),
//   E2E_APPROVAL_TIMEOUT_MINUTES (45), LIFI_ALLOW_BRIDGES /
//   EXPO_PUBLIC_LIFI_ALLOW_BRIDGES (default `across`, empty lets LiFi choose),
//   EXPO_PUBLIC_LIFI_API_KEY (optional), E2E_DEBUG=1 (SDK debug logs), DRY_RUN=1.
//
//   safewrap bun scripts/e2e/crosschain-swap-fast.ts
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  createPublicClient, createWalletClient, formatEther, formatUnits, http, keccak256, nonceManager, parseAbi, parseEther, toBytes, toHex,
} from 'viem';
import { base, mainnet, optimism } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import {
  APP_IDENTIFIER, CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM, CryptoService, Groth16Prover, KeystoreManager, LiFiSwapQuoteProvider,
  NoteComputationService, NoteManager, PoolSessionBuilder, PoseidonHashService, ViemRPCInteractor, prepareYieldSwapDeposit,
} from '@privacy-pools-v2/sdk';

import { STAGING_CHAINS } from '../../config/staging-deployments';
import { rpcUrlForChain } from '../visual/evm-wallet';
import { envValue } from './funding';

// --- Parameters (the slow run's, so the two spend alike) ---
const SOURCE_CHAIN = 10; // Optimism
// Destination: Base by default (cheaper and faster than Ethereum),
// E2E_DEST_CHAIN=1 for Ethereum. USDC is the destination entrypoint's native
// USDC asset; config/tokens cannot be imported from bun (react-native).
const DESTINATIONS = {
  1: { name: 'Ethereum', viem: mainnet, usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
  8453: { name: 'Base', viem: base, usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
} as const;
const DEST_CHAIN = Number(process.env.E2E_DEST_CHAIN ?? '8453') as keyof typeof DESTINATIONS;
if (!DESTINATIONS[DEST_CHAIN]) throw new Error(`E2E_DEST_CHAIN ${DEST_CHAIN} is not one of ${Object.keys(DESTINATIONS).join(', ')}`);
const DEST_NAME = DESTINATIONS[DEST_CHAIN].name;
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const DEST_USDC = { address: DESTINATIONS[DEST_CHAIN].usdc, symbol: 'USDC', decimals: 6 };
// The ppUSDC share on the Base STAGING deployment. Nothing in ppv2 config names
// it yet (staging has no yield deployments and the staging relayer publishes
// `yield: []`), so it is pinned here from the chain: PPRouterFactory
// RouterCreated / PPYieldTokenZapFactory ZapCreated for this vault, block
// 51737440 / 51737439. assertShareTarget() re-reads every field on chain
// before anything uses it.
const SHARE_TARGETS = {
  8453: {
    ppRouter: '0x8bd0146ff0420E3F310f1246a3016D91aaaa1059',
    zap: '0x372CE0d8F56f8BC3787969875a42ff63e9e029C1',
    ppUSDC: '0x6624BF6D380ff41dd7a1739AFf2875A8Da2033C8',
    ppUSDCDecimals: 18,
    underlying: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    underlyingDecimals: 6,
    underlyingSymbol: 'USDC',
    apyLabel: 'Aave v3',
  },
} as const;
const DEST_ASSET = (process.env.E2E_DEST_ASSET?.trim().toLowerCase() || 'usdc') as 'usdc' | 'ppusdc';
if (DEST_ASSET !== 'usdc' && DEST_ASSET !== 'ppusdc') throw new Error(`E2E_DEST_ASSET ${DEST_ASSET} is not usdc or ppusdc`);
const SHARE_DEPLOYMENT = DEST_ASSET === 'ppusdc' ? SHARE_TARGETS[DEST_CHAIN] : undefined;
if (DEST_ASSET === 'ppusdc' && !SHARE_DEPLOYMENT) throw new Error(`no ppUSDC share target is known on ${DEST_NAME}`);
// What the swap lands in: the plain USDC note, or the share note (18-decimal shares).
const DEST_TOKEN = SHARE_DEPLOYMENT
  ? { address: SHARE_DEPLOYMENT.ppUSDC, symbol: 'ppUSDC', decimals: SHARE_DEPLOYMENT.ppUSDCDecimals }
  : DEST_USDC;
// The share's entrypoint minimum is 10 shares on Base, which 0.001 ETH does not reach.
const SWAP_AMOUNT = parseEther(process.env.E2E_XSWAP_AMOUNT?.trim() || (SHARE_DEPLOYMENT ? '0.005' : '0.001'));
const SHIELD_AMOUNT = parseEther(process.env.E2E_XSWAP_SHIELD?.trim() || (SHARE_DEPLOYMENT ? '0.006' : '0.003'));
if (SHIELD_AMOUNT < SWAP_AMOUNT) throw new Error('E2E_XSWAP_SHIELD must cover E2E_XSWAP_AMOUNT');
const SLIPPAGE = 0.03;
const GAS_RESERVE = parseEther('0.0008');
const DEST_GAS_MIN = parseEther('0.0002');
const BRIDGE_AMOUNT = parseEther('0.001');
const APPROVAL_TIMEOUT_MS = Number(process.env.E2E_APPROVAL_TIMEOUT_MINUTES ?? '45') * 60_000;
const DELIVERY_TIMEOUT_MS = 30 * 60_000;
const BRIDGE_GAS_TIMEOUT_MS = 20 * 60_000;
const ASP_URL = process.env.E2E_ASP_URL ?? 'https://api-dev.0xbow.io';
const LIFI_DIAMOND = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae';
const DRY_RUN = process.env.DRY_RUN === '1';
const DEBUG = process.env.E2E_DEBUG === '1';
const ARTIFACTS_DIR = resolve(new URL('../..', import.meta.url).pathname, 'public/artifacts');
// Test only, as in the slow run's workflow: pin cross-chain quotes to Across.
// Set it empty to let LiFi choose.
const ALLOW_BRIDGES: string[] = (process.env.LIFI_ALLOW_BRIDGES ?? process.env.EXPO_PUBLIC_LIFI_ALLOW_BRIDGES ?? 'across')
  .split(',').map((b) => b.trim()).filter(Boolean);
const LIFI_API_KEY = process.env.EXPO_PUBLIC_LIFI_API_KEY?.trim() || undefined;

// Proving under bun: ffjavascript's worker-thread bn128 curve never finishes
// building here (buildBn128(false) hung for minutes at full CPU, buildBn128(true)
// takes ~80ms), and snarkjs asks for the threaded one on every prove and verify.
// ffjavascript returns a curve cached on globalThis to those calls, so cache a
// single-threaded one first. Built with snarkjs's OWN ffjavascript (it nests a
// newer copy), resolved from snarkjs so a different hoisting still finds it.
{
  const fromSnarkjs = createRequire(createRequire(import.meta.url).resolve('snarkjs'));
  const { buildBn128 } = fromSnarkjs('ffjavascript');
  globalThis.curve_bn128 = await buildBn128(true);
}

class E2EFail extends Error {}
// Throws, never exits: the top-level catch reports and the finally closes.
function fail(message: string): never {
  throw new E2EFail(message);
}

// --- Output: timeline, tx list, and never a secret ---
const ALCHEMY_KEY = process.env.EXPO_PUBLIC_ALCHEMY_KEY?.trim() || envValue('EXPO_PUBLIC_ALCHEMY_KEY');
if (ALCHEMY_KEY && !process.env.EXPO_PUBLIC_ALCHEMY_KEY) process.env.EXPO_PUBLIC_ALCHEMY_KEY = ALCHEMY_KEY;
// RPC URLs carry the Alchemy key and viem puts the URL in its error text.
const redact = (s: string) => (ALCHEMY_KEY ? s.split(ALCHEMY_KEY).join('***') : s);
const started = Date.now();
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const log = (msg: string) => console.log(redact(`[${secs(Date.now() - started).padStart(7)}] ${msg}`));
const timeline: { name: string; ms: number; ok: boolean; note?: string }[] = [];
const txs: { what: string; chainId: number; hash: string }[] = [];
function recordTx(what: string, chainId: number, hash: string) {
  txs.push({ what, chainId, hash });
  log(`tx ${what} on chain ${chainId}: ${hash}`);
}
async function step<T>(name: string, fn: () => Promise<T>, note?: (v: T) => string | undefined): Promise<T> {
  const t = Date.now();
  log(`-> ${name}`);
  try {
    const v = await fn();
    const n = note?.(v);
    timeline.push({ name, ms: Date.now() - t, ok: true, ...(n ? { note: n } : {}) });
    log(`<- ${name} (${secs(Date.now() - t)})${n ? `: ${n}` : ''}`);
    return v;
  } catch (e) {
    timeline.push({ name, ms: Date.now() - t, ok: false });
    throw e;
  }
}
const skip = (name: string, why: string) => { timeline.push({ name, ms: 0, ok: true, note: `skipped: ${why}` }); log(`-- ${name} skipped: ${why}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (v: bigint) => `0x${v.toString(16)}`;

const sdkLogger = {
  level: DEBUG ? 'debug' : 'warn',
  child() { return sdkLogger; },
  debug: (m: string, o?: object) => { if (DEBUG) log(`[sdk] ${m} ${o ? JSON.stringify(o, big).slice(0, 400) : ''}`); },
  info: (m: string, o?: object) => { if (DEBUG) log(`[sdk] ${m} ${o ? JSON.stringify(o, big).slice(0, 400) : ''}`); },
  warn: (m: string, o?: object) => log(`[sdk warn] ${m} ${o ? JSON.stringify(o, big).slice(0, 400) : ''}`),
  error: (m: string, o?: object) => log(`[sdk error] ${m} ${o ? JSON.stringify(o, big).slice(0, 600) : ''}`),
  fatal: (m: string, o?: object) => log(`[sdk fatal] ${m} ${o ? JSON.stringify(o, big).slice(0, 600) : ''}`),
};
function big(_k: string, v: unknown) { return typeof v === 'bigint' ? v.toString() : v; }

// --- Account, clients, deployments ---
const rawKey = process.env.E2E_PK ?? envValue('DEV_PK');
if (!rawKey) throw new Error('E2E_PK (or DEV_PK in .env) is required');
// With a nonce manager: the keystore registration sends two transactions back
// to back, and Alchemy's Base node answered the second nonce lookup with the
// first one's nonce, so the second was refused as "replacement transaction
// underpriced" (run 36142255277). The manager counts nonces locally per chain.
const acct = privateKeyToAccount(`0x${rawKey.replace(/^0x/, '')}`, { nonceManager });
if (!ALCHEMY_KEY) throw new Error('EXPO_PUBLIC_ALCHEMY_KEY is required');
const OP_RPC = rpcUrlForChain(SOURCE_CHAIN);
const ETH_RPC = rpcUrlForChain(DEST_CHAIN);
const op = createPublicClient({ chain: optimism, transport: http(OP_RPC) });
const eth = createPublicClient({ chain: DESTINATIONS[DEST_CHAIN].viem, transport: http(ETH_RPC) });
const opWallet = createWalletClient({ account: acct, chain: optimism, transport: http(OP_RPC) });
const ethWallet = createWalletClient({ account: acct, chain: DESTINATIONS[DEST_CHAIN].viem, transport: http(ETH_RPC) });

const stagingFor = (id: number) => {
  const d = STAGING_CHAINS.find((c) => c.chainId === id);
  if (!d?.relaySwaps || !d.relayerBaseUrl) throw new Error(`no staging deployment with RelaySwaps and a relayer for chain ${id}`);
  return d;
};
const SRC = stagingFor(SOURCE_CHAIN);
// The destination only receives a LiFi deposit, so it needs no RelaySwaps.
const DST = STAGING_CHAINS.find((c) => c.chainId === DEST_CHAIN);
if (!DST) throw new Error(`no staging deployment for chain ${DEST_CHAIN}`);
const deploymentOf = (d) => ({
  poolAddress: d.pool, entrypointAddress: d.entrypoint, keystoreAddress: d.keystore,
  aspRegistryAddress: d.aspRegistry, relaySwapsAddress: d.relaySwaps,
});
const scanFloor = (d) => (d.keystoreFromBlock < d.fromBlock ? d.keystoreFromBlock : d.fromBlock);

// --- LiFi, as services/pool-session-service.ts builds it ---
let lastRouteTool: string | undefined;
const lifi = new LiFiSwapQuoteProvider({
  ...(LIFI_API_KEY ? { apiKey: LIFI_API_KEY } : {}),
  ...(ALLOW_BRIDGES.length ? { allowBridges: ALLOW_BRIDGES } : {}),
});
{
  const realSwap = lifi.getSwapQuote.bind(lifi);
  lifi.getSwapQuote = async (params) => {
    const r = await realSwap(params);
    if (r?.tool && params.fromChainId !== params.toChainId) lastRouteTool = r.tool;
    return r;
  };
  const realSwapAndDeposit = lifi.getSwapAndDepositQuote.bind(lifi);
  lifi.getSwapAndDepositQuote = async (params) => {
    const r = await realSwapAndDeposit({
      // swapDepositSlippage: 1% same-chain, 3% cross-chain; callers still win.
      slippage: params.fromChainId === (params.toChainId ?? params.fromChainId) ? 0.01 : 0.03,
      ...params,
    });
    if (r?.tool) lastRouteTool = r.tool;
    // LiFi's contractCalls endpoint does not honour allowBridges (probed
    // 2026-09-24: allow=[across] still answered stargateV2), so say so when the
    // deposit leg left the pin.
    if (r?.tool && ALLOW_BRIDGES.length && params.fromChainId !== params.toChainId && !ALLOW_BRIDGES.includes(r.tool)) {
      log(`WARNING: LiFi routed the deposit leg via ${r.tool}, outside the allowlist ${ALLOW_BRIDGES.join(',')}`);
    }
    return r;
  };
}
// The SDK's own prover, timed, so the timeline shows what proving costs.
const baseProver = new Groth16Prover();
const timedProver = {
  async fullProve(input, wasm, provingKey) {
    const t = Date.now();
    const r = await baseProver.fullProve(input, wasm, provingKey);
    log(`  proof generated in ${secs(Date.now() - t)} (zkey ${(provingKey.length / 1e6).toFixed(1)} MB)`);
    return r;
  },
  verify: (vk, signals, proof) => baseProver.verify(vk, signals, proof),
};
// In-memory note managers the sessions write into; read back here.
const noteManagers = { src: new NoteManager({}, { logger: sdkLogger }), dst: new NoteManager({}, { logger: sdkLogger }) };
const findSrcNote = (commitment: string) => noteManagers.src.getNotes()
  .find((n) => n.commitment.toLowerCase() === String(commitment).toLowerCase());

let exitCode = 0;
try {
  log(`account ${acct.address}${DRY_RUN ? ' (DRY_RUN: nothing will be sent)' : ''}`);
  log(`swap ${formatEther(SWAP_AMOUNT)} ETH on Optimism -> ${DEST_TOKEN.symbol} on ${DEST_NAME}, slippage ${SLIPPAGE * 100}%, bridges ${ALLOW_BRIDGES.join(',') || '(LiFi choice)'}`);
  const dryProblems: string[] = [];
  // In a dry run a funds shortfall is reported and the quote still runs.
  const refuse = (msg: string) => { if (DRY_RUN) { dryProblems.push(msg); log(`WOULD FAIL: ${msg}`); } else fail(msg); };

  // --- 1a. Funds, first pass: enough gas on OP to do anything at all ---
  const funds0 = await step('funds check (balances)', async () => {
    const [opBal, ethBal] = await Promise.all([op.getBalance({ address: acct.address }), eth.getBalance({ address: acct.address })]);
    if (opBal < GAS_RESERVE) refuse(`OUT OF FUNDS ON OPTIMISM: ${acct.address} holds ${formatEther(opBal)} ETH, the run needs at least ${formatEther(GAS_RESERVE)} for gas. Top it up on OP and re-run.`);
    return { opBal, ethBal };
  }, (f) => `${formatEther(f.opBal)} ETH on Optimism, ${formatEther(f.ethBal)} ETH on ${DEST_NAME}`);

  // --- 2. Keys, the app's derivation (services/sdk-setup.ts) ---
  const protocolKeys = await step('derive protocol keys', async () => {
    const addressHash = keccak256(toBytes(acct.address));
    const signature = await acct.signTypedData({
      domain: {
        name: 'Standardized Secret Derivation', version: '1',
        verifyingContract: '0x0000000000000000000000000000000000000000', salt: keccak256(toHex(APP_IDENTIFIER)),
      },
      types: { SecretDerivation: [{ name: 'purpose', type: 'string' }, { name: 'addressHash', type: 'bytes32' }] },
      primaryType: 'SecretDerivation',
      message: {
        purpose: 'This signature is used to deterministically derive application-specific secrets from your master seed. It is not a transaction and will not cost any gas.',
        addressHash,
      },
    });
    const km = KeystoreManager.fromSignature(
      { signature, signerAddress: acct.address, addressHash, revocableKeyIndex: '0x0' },
      { cryptoService: new CryptoService() },
    );
    const vk = km.getViewingKeyPair();
    return {
      privateNullifyingKey: km.getPrivateNullifyingKey(),
      privateRevocableKey: km.getPrivateRevocableKey(),
      revocableKeyIndex: km.getRevocableKeyIndex(),
      viewingPrivateKey: vk.privateKey,
      viewingPublicKey: vk.publicKey,
    };
  });

  // --- Relayer: the swap route binds to the chain's RelaySwaps, and the relayer
  // must publish the same one (services/relayer-details.ts assertRelayerSwapProcessor).
  const relayerInfo = await step('relayer details (Optimism)', async () => {
    const res = await fetch(`${SRC.relayerBaseUrl.replace(/\/+$/, '')}/v1/details/evm/${SOURCE_CHAIN}`);
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.id !== SOURCE_CHAIN) fail(`relayer details for chain ${SOURCE_CHAIN}: HTTP ${res.status}`);
    const published = body.contracts?.relaySwaps;
    if (published && published.toLowerCase() !== SRC.relaySwaps.toLowerCase()) {
      fail(`the relayer relays through RelaySwaps ${published}, the staging config pins ${SRC.relaySwaps}`);
    }
    if (body.swapsSupported === false) fail('the relayer does not serve swaps on Optimism');
    return {
      url: SRC.relayerBaseUrl, name: 'Fast Relay', chainId: SOURCE_CHAIN, chainType: 'evm', status: 'active',
      address: body.relayerAddress ?? SRC.relayerSigner, processorAddress: SRC.relaySwaps,
    };
  }, (r) => `processor ${r.processorAddress}, relayer ${r.address}`);

  // --- 3. Sessions: the destination first, its yields feed the source's targets ---
  const rpcInteractor = (client, d) => new ViemRPCInteractor(
    { publicClient: client, chunkSize: d.logsMaxBlockRange ?? 10_000n, minFromBlock: scanFloor(d) },
    { logger: sdkLogger },
  );
  const { src, dst } = await step('build sessions', async () => {
    const dstBuilder = PoolSessionBuilder.fromConfig({
      chainId: DEST_CHAIN, rpcUrl: ETH_RPC, ownerAddress: acct.address, aspUrl: ASP_URL,
      deployment: deploymentOf(DST), deploymentBlock: hex(scanFloor(DST)), protocolKeys,
      circuitArtifactsDir: ARTIFACTS_DIR,
      // No RelaySwaps on Base: this session only prepares the deposit, so the
      // withdrawal relay stands in as its processor.
      relayers: [{ ...relayerInfo, chainId: DEST_CHAIN, processorAddress: DST.relaySwaps ?? DST.relay }],
      walletInteractor: { type: 'viem', walletClient: ethWallet },
      logger: sdkLogger,
    }).withGroth16Prover(timedProver).withNoteManager(noteManagers.dst).withRpcInteractor(rpcInteractor(eth, DST));
    // The share target rides the destination session's yield config, as
    // services/pool-session-service.ts passes yieldDeployment; its yields then
    // feed the source session's destination targets below.
    if (SHARE_DEPLOYMENT) dstBuilder.withYieldDeployment(SHARE_DEPLOYMENT);
    const dst = await dstBuilder.create();
    const src = await PoolSessionBuilder.fromConfig({
      chainId: SOURCE_CHAIN, rpcUrl: OP_RPC, ownerAddress: acct.address, aspUrl: ASP_URL,
      deployment: deploymentOf(SRC), deploymentBlock: hex(scanFloor(SRC)), protocolKeys,
      circuitArtifactsDir: ARTIFACTS_DIR,
      relayers: [relayerInfo],
      walletInteractor: { type: 'viem', walletClient: opWallet },
      logger: sdkLogger,
      destinationChainId: DEST_CHAIN, destinationRpcUrl: ETH_RPC, destinationDeployment: deploymentOf(DST),
    })
      .withDestinationYieldDepositTargets([...dst.yields])
      .withSwapQuoteProvider(lifi)
      .withSwapAndDepositQuoteProvider(lifi)
      .withGroth16Prover(timedProver)
      .withNoteManager(noteManagers.src)
      .withRpcInteractor(rpcInteractor(op, SRC))
      .create();
    return { src, dst };
  });

  // The destination entrypoint's minimum for the share, read on chain below.
  // quoteReshield refuses under it before anything is signed.
  let shareMin: bigint | undefined;
  if (SHARE_DEPLOYMENT) {
    shareMin = await step(`share target (${DEST_TOKEN.symbol} on ${DEST_NAME})`, () => assertShareTarget(dst), (min) => `router ${SHARE_DEPLOYMENT.ppRouter}, entrypoint minimum ${formatUnits(min, DEST_TOKEN.decimals)} ${DEST_TOKEN.symbol}`);
  }

  const [regOp, regEth] = await step('keystore registration status', () => Promise.all([
    src.isKeystoreRegistered(), dst.isKeystoreRegistered(),
  ]), ([a, b]) => `Optimism ${a ? 'registered' : 'NOT registered'}, ${DEST_NAME} ${b ? 'registered' : 'NOT registered'}`);

  // --- 4. Notes on Optimism ---
  const ethNotes = () => noteManagers.src.getNotes().filter((n) => n.isOwned && n.tokenId.toLowerCase() === NATIVE.toLowerCase());
  await step('discover notes (Optimism)', () => src.discoverNotes({ fromBlock: hex(scanFloor(SRC)) }), () => {
    const mine = ethNotes();
    const by = (s) => mine.filter((n) => n.status === s).length;
    return `${mine.length} ETH notes: ${by('ACTIVE')} active, ${by('PENDING')} pending, ${by('INACTIVE')} inactive, ${by('SPENT')} spent`;
  });
  // The smallest approved note that covers the swap, so the big change note is
  // reused across runs; a pending one that covers it is waited for, not re-shielded.
  const pickActive = () => ethNotes()
    .filter((n) => n.status === 'ACTIVE' && BigInt(n.value) >= SWAP_AMOUNT)
    .sort((a, b) => (BigInt(a.value) < BigInt(b.value) ? -1 : 1))[0];
  let input = pickActive();
  const waiting = input ? undefined : ethNotes()
    .filter((n) => (n.status === 'PENDING' || n.status === 'INACTIVE') && BigInt(n.value) >= SWAP_AMOUNT)
    .sort((a, b) => (BigInt(a.value) > BigInt(b.value) ? -1 : 1))[0];
  const needsShield = !input && !waiting;
  log(input
    ? `spendable note ${input.commitment} holds ${formatEther(BigInt(input.value))} ETH`
    : waiting ? `note ${waiting.commitment} (${formatEther(BigInt(waiting.value))} ETH) covers the swap but is ${waiting.status}; will wait for approval`
      : `no ETH note on Optimism covers ${formatEther(SWAP_AMOUNT)}; a shield of ${formatEther(SHIELD_AMOUNT)} is needed`);

  // --- 1b. Funds, full rule, before the first transaction ---
  const needsBridge = !regEth && funds0.ethBal < DEST_GAS_MIN;
  await step('funds check (plan)', async () => {
    const opNeeded = GAS_RESERVE + (needsBridge ? BRIDGE_AMOUNT : 0n) + (needsShield ? SHIELD_AMOUNT : 0n);
    if (funds0.opBal < opNeeded) {
      refuse(`OUT OF FUNDS ON OPTIMISM: ${acct.address} holds ${formatEther(funds0.opBal)} ETH, the run needs at least ${formatEther(opNeeded)} `
        + `(gas${needsBridge ? `, a bridge for ${DEST_NAME} gas` : ''}${needsShield ? ', a shield' : ''}). Top it up on OP and re-run.`);
    }
  }, () => `bridge ${needsBridge ? 'yes' : 'no'}, register ${DEST_NAME} ${regEth ? 'no' : 'yes'}, register Optimism ${regOp ? 'no' : 'yes'}, shield ${needsShield ? 'yes' : 'no'}`);

  const noteComputation = new NoteComputationService({ hashService: await PoseidonHashService.create(), cryptoService: new CryptoService() });

  if (DRY_RUN) {
    // Quote the swap for the note the run would spend (or the swap amount) and stop.
    await step('quote (estimate + deposit proof + relayer quote)', async () => {
      const q = await quoteReshield(src, dst, relayerInfo, SWAP_AMOUNT, shareMin);
      return q;
    }, (q) => `note ${formatUnits(BigInt(q.estimate.noteValue), DEST_TOKEN.decimals)} ${DEST_TOKEN.symbol}, relayer fee ${formatEther(BigInt(q.quote.feeAmount))} ETH, via ${lastRouteTool ?? '(tool not reported)'}`);
    if (dryProblems.length) fail(`dry run found ${dryProblems.length} blocker(s): ${dryProblems.join(' | ')}`);
    log('DRY_RUN complete: nothing was sent.');
  } else {
    // --- 5. Gas on the destination for the one-time registration there ---
    if (needsBridge) await step(`bridge gas to ${DEST_NAME}`, bridgeGasToDest);
    else skip(`bridge gas to ${DEST_NAME}`, regEth ? `registered on ${DEST_NAME}` : `enough ETH on ${DEST_NAME}`);

    // --- 6. Registration (the app asks for both before the quote) ---
    if (!regEth) {
      await step(`register keystore on ${DEST_NAME}`, async () => {
        for (const r of await dst.registerKeystore()) { recordTx('keystore registration', DEST_CHAIN, r.txHash); if (!r.status) fail(`registration on ${DEST_NAME} reverted: ${r.txHash}`); }
      });
    } else skip(`register keystore on ${DEST_NAME}`, 'already registered');
    if (!regOp) {
      await step('register keystore on Optimism', async () => {
        for (const r of await src.registerKeystore()) { recordTx('keystore registration', SOURCE_CHAIN, r.txHash); if (!r.status) fail(`registration on Optimism reverted: ${r.txHash}`); }
      });
    } else skip('register keystore on Optimism', 'already registered');

    // --- 7. Shield and wait for the ASP, when there is no approved note ---
    let target = waiting;
    if (needsShield) {
      target = await step(`shield ${formatEther(SHIELD_AMOUNT)} ETH on Optimism`, async () => {
        const prepared = await src.prepareDeposit({ tokenId: NATIVE, value: hex(SHIELD_AMOUNT) });
        const receipt = await src.executeDeposit(prepared);
        recordTx('shield', SOURCE_CHAIN, receipt.txHash);
        if (receipt.status !== true) fail(`the shield reverted: ${receipt.txHash}`);
        return { ...prepared.pendingNote, createdAtBlock: receipt.blockNumber };
      }, (n) => `commitment ${n.commitment}`);
    } else skip('shield', input ? 'an approved note covers the swap' : 'a pending note covers the swap');
    if (!input) {
      input = await step('ASP approval + association set + discovery', () => waitForApproval(src, target, noteComputation));
    } else skip('ASP approval', 'note already approved');

    // --- 8. The swap (flow 4) ---
    const { quote, receipt } = await step('cross-chain reshield (estimate, prove, quote, relay)', async () => {
      const q = await quoteReshield(src, dst, relayerInfo, SWAP_AMOUNT, shareMin);
      const receipt = await src.relayReshieldCrosschain({
        inputCommitments: [input.commitment],
        // NET, never the gross that went into prepare.
        amount: q.quote.netAmount,
        tokenId: NATIVE,
        outputToken: DEST_TOKEN.address,
        toChainId: DEST_CHAIN,
        toChainType: 'evm',
        fallbackAddress: acct.address,
        swapCalldata: q.quote.swapCalldata,
        selectedQuote: q.quote.selectedQuote,
        swapTarget: q.quote.swapTarget,
        approvalAddress: q.quote.approvalAddress,
        dustRecipient: q.quote.dustRecipient,
        ...(q.depositResult?.pendingNote ? { depositNote: q.depositResult.pendingNote } : {}),
        ...(q.quote.dustRescue ? { dustRescue: q.quote.dustRescue } : {}),
        // B2 fields exist only for a non-native input whose route wants msg.value;
        // undefined for ETH, passed through so an ERC-20 input would not break.
        ...(q.quote.swapValue !== undefined ? { swapValue: q.quote.swapValue, gasSwapMaxInput: q.quote.gasSwapMaxInput, gasSwapCalldata: q.quote.gasSwapCalldata } : {}),
      });
      if (receipt?.txHash) recordTx('relayed reshield (source leg)', SOURCE_CHAIN, receipt.txHash);
      // Only a literal true is success (project rule).
      if (receipt?.status !== true) fail(`the cross-chain reshield ${receipt?.status === false ? 'reverted' : 'could not be confirmed'} (tx ${receipt?.txHash ?? 'none'})`);
      return { ...q, receipt };
    }, (r) => `note ${formatUnits(BigInt(r.estimate.noteValue), DEST_TOKEN.decimals)} ${DEST_TOKEN.symbol}, fee ${formatEther(BigInt(r.quote.feeAmount))} ETH, via ${lastRouteTool ?? '?'}`);
    const depositNote = quote.depositNote;

    // --- 9. Delivery verdict ---
    const delivered = await step('bridge delivery (LiFi status)', () => waitForDelivery(receipt.txHash, lastRouteTool));
    recordTx('destination deposit (LiFi receiving)', DEST_CHAIN, delivered.receiving.txHash);
    await step(`discover the ${DEST_TOKEN.symbol} note on ${DEST_NAME}`, async () => {
      const rcpt = await eth.getTransactionReceipt({ hash: delivered.receiving.txHash });
      const until = Date.now() + 5 * 60_000;
      for (;;) {
        await dst.discoverNotes({ fromBlock: hex(rcpt.blockNumber - 1n) });
        const found = noteManagers.dst.getNotes().find((n) => n.commitment.toLowerCase() === String(depositNote.commitment).toLowerCase());
        if (found) {
          // The right asset and a real amount: a share run must land a share
          // note, never a plain USDC one the bridge fallback could explain.
          if (String(found.tokenId).toLowerCase() !== DEST_TOKEN.address.toLowerCase()) {
            fail(`note ${found.commitment} is token ${found.tokenId}, expected ${DEST_TOKEN.symbol} ${DEST_TOKEN.address}`);
          }
          if (BigInt(found.value) <= 0n) fail(`note ${found.commitment} holds no ${DEST_TOKEN.symbol}`);
          return found;
        }
        if (Date.now() > until) fail(`LiFi reports DONE but note ${depositNote.commitment} is not on ${DEST_NAME} after 5 minutes`);
        await sleep(15_000);
      }
    }, (n) => `${n.commitment} ${formatUnits(BigInt(n.value), DEST_TOKEN.decimals)} ${DEST_TOKEN.symbol} (${n.status})`);
    log(`PASS: deposited ${DEST_TOKEN.symbol} on ${DEST_NAME}`);
  }
} catch (err) {
  exitCode = 1;
  const msg = err instanceof Error ? `${err.name === 'E2EFail' || err instanceof E2EFail ? '' : `${err.name}: `}${err.message}` : String(err);
  console.error(redact(`\nFAIL: ${msg}`));
  if (DEBUG && err instanceof Error && err.stack) console.error(redact(err.stack));
} finally {
  await closeResources();
  printSummary();
}
process.exitCode = exitCode;
// snarkjs worker threads can outlive the run; nothing is in flight by now.
setTimeout(() => process.exit(exitCode), 3000).unref();

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Flow 4 up to the relay: estimate -> destination deposit proof -> relayer
 * quote, with services/swap-flows.ts runReshieldCrosschain's guards. Retries
 * only on the SDK's own "quote again" trips (template: v2-monorepo
 * packages/swaps/test), all of which happen before anything is signed.
 */
async function quoteReshield(src, dst, relayerInfo, grossWei: bigint, shareMin?: bigint) {
  const ATTEMPTS = 4;
  for (let attempt = 1; ; attempt++) {
    try {
      const estimate = await src.estimateReshieldCrosschainAmount({
        relayerInfo, amount: hex(grossWei), tokenId: NATIVE, outputToken: DEST_TOKEN.address,
        toChainId: DEST_CHAIN, toChainType: 'evm', fallbackAddress: acct.address, slippage: SLIPPAGE,
      });
      log(`estimate: fee ${formatEther(BigInt(estimate.feeAmount))} ETH, swap ${formatEther(BigInt(estimate.netSwapAmount))} ETH, `
        + `out ~${formatUnits(BigInt(estimate.estimatedOutput), DEST_USDC.decimals)} (min ${formatUnits(BigInt(estimate.estimatedMinOutput), DEST_USDC.decimals)}), `
        + `note ${formatUnits(BigInt(estimate.noteValue), DEST_TOKEN.decimals)} ${DEST_TOKEN.symbol}, vetting ${formatUnits(BigInt(estimate.vettingFee), DEST_TOKEN.decimals)}, deposit budget ${formatUnits(BigInt(estimate.totalDepositCost), DEST_USDC.decimals)} USDC, route ${lastRouteTool ?? '?'}`);
      if (BigInt(estimate.noteValue) <= 0n) fail('the route would produce nothing to redeposit at this amount');
      if (BigInt(estimate.netSwapAmount || '0') <= 0n) fail('the relayer fee covers the whole amount');
      // Under the destination minimum the deposit reverts AFTER the bridge and
      // the funds land in the fallback wallet. The SDK refuses this too
      // (DepositBelowMinimum in the estimate and in prepareReshieldCrosschainQuote,
      // which the app's runReshieldCrosschain treats as final); checked here
      // as well so the e2e never depends on that alone.
      const belowMin = (v: bigint) => shareMin !== undefined && v < shareMin;
      if (belowMin(BigInt(estimate.noteValue))) {
        fail(`the share note would be ${formatUnits(BigInt(estimate.noteValue), DEST_TOKEN.decimals)} ${DEST_TOKEN.symbol}, under the ${DEST_NAME} minimum of ${formatUnits(shareMin, DEST_TOKEN.decimals)}. Raise E2E_XSWAP_AMOUNT.`);
      }
      // services/swap-flows.ts buildRedeposit. Plain USDC: its non-share branch.
      // ppUSDC: its share branch, the router deposit sized from the estimate's
      // funding budget (totalDepositCost, noteValue is in shares) with the
      // cross-chain rate headroom, re-checking the session can serve the share
      // first (redepositYieldTarget with requireShareRoute).
      const depositResult = SHARE_DEPLOYMENT
        ? await prepareYieldSwapDeposit(
          shareTargetOf(dst), BigInt(estimate.totalDepositCost), CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM,
        )
        : await dst.prepareDeposit({ tokenId: DEST_USDC.address, value: estimate.noteValue });
      if (SHARE_DEPLOYMENT) {
        const pn = depositResult?.pendingNote;
        if (!pn?.commitment || BigInt(pn.value ?? 0) <= 0n) fail('the share deposit proof carries no note');
        if (String(pn.tokenId).toLowerCase() !== DEST_TOKEN.address.toLowerCase()) {
          fail(`the share deposit proof is for token ${pn.tokenId}, not ${DEST_TOKEN.address}`);
        }
        if (belowMin(BigInt(pn.value))) {
          fail(`the sized share note is ${formatUnits(BigInt(pn.value), DEST_TOKEN.decimals)} ${DEST_TOKEN.symbol}, under the ${DEST_NAME} minimum of ${formatUnits(shareMin, DEST_TOKEN.decimals)}`);
        }
        log(`share deposit sized: ${formatUnits(BigInt(pn.value), DEST_TOKEN.decimals)} ${DEST_TOKEN.symbol} for a budget of ${formatUnits(BigInt(estimate.totalDepositCost), DEST_USDC.decimals)} USDC`);
      }
      const quote = await src.prepareReshieldCrosschainQuote({
        relayerInfo, amount: hex(grossWei), tokenId: NATIVE, outputToken: DEST_TOKEN.address,
        toChainId: DEST_CHAIN, toChainType: 'evm', fallbackAddress: acct.address, depositResult,
        totalDepositCost: estimate.totalDepositCost, slippage: SLIPPAGE,
      });
      assertReshieldRelayAmount(quote, grossWei);
      if (quote.fallbackAddress && quote.fallbackAddress.toLowerCase() !== acct.address.toLowerCase()) {
        fail(`the quote pays the fallback to ${quote.fallbackAddress}, not this account`);
      }
      log(`quote: net ${formatEther(BigInt(quote.netAmount))} ETH, fee ${formatEther(BigInt(quote.feeAmount))} ETH, target ${quote.swapTarget}, via ${lastRouteTool ?? '?'}`);
      return { estimate, depositResult, quote };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const transient = (/Invalid transact params/.test(msg) && /LiFi needs .* input but only .* available after fee/.test(msg))
        || (/422/.test(msg) && /Market conditions have changed/.test(msg))
        || /exceeds the bridge's guaranteed delivery/.test(msg)
        // services/swap-flows.ts isStaleCrosschainQuote: the guarantee drifted
        // under the sized deposit, or a share's rate accrued between two reads.
        || (e instanceof Error && e.name === 'DestinationDepositUnaffordable')
        || /moved while sizing/.test(msg);
      if (e instanceof E2EFail || !transient || attempt >= ATTEMPTS) throw e;
      log(`quote attempt ${attempt}/${ATTEMPTS} tripped a transient check, quoting again: ${msg.slice(0, 200)}`);
    }
  }
}

/** services/swap-flows.ts assertReshieldRelayAmount: the spend is pinned to the gross. */
function assertReshieldRelayAmount(quote, grossWei: bigint) {
  const net = BigInt(quote.netAmount);
  const fee = BigInt(quote.feeAmount || '0');
  if (net <= 0n) fail('the relayer quote has no net amount');
  if (fee < 0n) fail('the relayer quote has a negative fee');
  if (net + fee !== grossWei) fail(`the relayer quote covers ${formatEther(net + fee)} ETH, asked ${formatEther(grossWei)}`);
  const signed = quote.selectedQuote?.quote;
  const amountSent = signed?.feeCommitment?.amountSent;
  if (amountSent !== undefined && BigInt(amountSent) !== grossWei) fail(`the signed commitment spends ${amountSent}, not ${grossWei}`);
  if (signed?.feeAmount !== undefined && BigInt(signed.feeAmount) !== fee) fail(`the signed fee ${signed.feeAmount} differs from the reported ${fee}`);
}

/**
 * services/swap-flows.ts redepositYieldTarget with requireShareRoute: the
 * destination session's namespace for the share, and only when it is keyed by
 * that exact share (yieldFor also answers for the underlying).
 */
function shareTargetOf(dst) {
  const target = dst.yieldFor?.(DEST_TOKEN.address);
  if (target?.deployment?.ppUSDC?.toLowerCase() !== DEST_TOKEN.address.toLowerCase()) {
    fail(`the ${DEST_NAME} session cannot deposit into ${DEST_TOKEN.symbol} ${DEST_TOKEN.address}`);
  }
  return target;
}

/**
 * The pinned share target, re-read on chain: the router wraps this share for
 * this pool and entrypoint, in ERC-20 mode over USDC, and the entrypoint has
 * the share enabled. Then the session side: dst.yields carries it and it
 * serves the share. Returns the entrypoint's minimum deposit, in shares.
 */
async function assertShareTarget(dst) {
  const d = SHARE_DEPLOYMENT;
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const routerAbi = parseAbi([
    'function VAULT() view returns (address)', 'function ENTRYPOINT() view returns (address)',
    'function POOL_VAULT() view returns (address)', 'function UNDERLYING() view returns (address)',
    'function ZAP() view returns (address)', 'function NATIVE_MODE() view returns (bool)',
  ]);
  const read = (functionName) => eth.readContract({ address: d.ppRouter, abi: routerAbi, functionName });
  const [routerCode, shareCode] = await Promise.all([eth.getCode({ address: d.ppRouter }), eth.getCode({ address: d.ppUSDC })]);
  if (!routerCode || routerCode === '0x') fail(`no bytecode at the ${DEST_NAME} router ${d.ppRouter}`);
  if (!shareCode || shareCode === '0x') fail(`no bytecode at the ${DEST_NAME} share ${d.ppUSDC}`);
  const [vault, entrypoint, pool, underlying, zap, nativeMode] = await Promise.all(
    ['VAULT', 'ENTRYPOINT', 'POOL_VAULT', 'UNDERLYING', 'ZAP', 'NATIVE_MODE'].map(read),
  );
  if (!same(vault, d.ppUSDC)) fail(`router VAULT() is ${vault}, not ${d.ppUSDC}`);
  if (!same(entrypoint, DST.entrypoint)) fail(`router ENTRYPOINT() is ${entrypoint}, staging pins ${DST.entrypoint}`);
  if (!same(pool, DST.pool)) fail(`router POOL_VAULT() is ${pool}, staging pins ${DST.pool}`);
  if (!same(underlying, d.underlying)) fail(`router UNDERLYING() is ${underlying}, not ${d.underlying}`);
  if (!same(zap, d.zap)) fail(`router ZAP() is ${zap}, not ${d.zap}`);
  if (nativeMode !== false) fail('the router is in native mode, not an ERC-20 share route');
  const [enabled, minAmount] = await eth.readContract({
    address: DST.entrypoint,
    abi: parseAbi(['function assets(address) view returns ((bool enabled, uint256 minAmount, uint256 vettingFeeBPS, uint256 maxRelayFee))']),
    functionName: 'assets',
    args: [d.ppUSDC],
  }).then((c) => [c.enabled, c.minAmount]);
  if (!enabled) fail(`the ${DEST_NAME} entrypoint does not have ${DEST_TOKEN.symbol} enabled`);
  if (!dst.yields?.some((y) => same(y.deployment?.ppUSDC, d.ppUSDC))) fail(`the ${DEST_NAME} session has no yield target for ${DEST_TOKEN.symbol}`);
  shareTargetOf(dst);
  return minAmount;
}

/**
 * The note's label approved by the staging ASP and its hash in the chain-10
 * association set, then discovery until the SDK promotes it to ACTIVE.
 */
async function waitForApproval(src, note, noteComputation) {
  const until = Date.now() + APPROVAL_TIMEOUT_MS;
  const labelHash = BigInt(noteComputation.computeLabelHash(note.label)).toString();
  let last = '';
  const say = (s: string) => { if (s !== last) { log(`  ${s}`); last = s; } };
  for (;;) {
    const status = await fetch(`${ASP_URL}/labels/${labelHash}/status`).then((r) => r.json()).then((b) => b?.status ?? 'unknown').catch(() => 'unreachable');
    if (status === 'rejected' || status === 'poi_required') fail(`the ASP answered "${status}" for the note's label; it will not become spendable`);
    let included = false;
    if (status === 'approved') {
      const leaves = await fetch(`${ASP_URL}/association-set/leaves?chainId=${SOURCE_CHAIN}&entrypoint=${SRC.entrypoint}`)
        .then((r) => r.json()).then((b) => b?.leaves ?? []).catch(() => []);
      included = leaves.includes(labelHash);
    }
    say(`label ${status}${status === 'approved' ? `, in association set: ${included}` : ''}`);
    if (included) {
      const from = note.createdAtBlock ? BigInt(note.createdAtBlock) - 1n : scanFloor(SRC);
      await src.discoverNotes({ fromBlock: hex(from) });
      const active = findSrcNote(note.commitment);
      if (active?.status === 'ACTIVE') return active;
      say(`included, SDK status ${active?.status ?? 'not discovered'}`);
    }
    if (Date.now() > until) fail(`the shielded ETH on Optimism was not approved within ${APPROVAL_TIMEOUT_MS / 60_000} minutes (label ${status}). No swap was sent.`);
    await sleep(20_000);
  }
}
/**
 * LiFi's verdict, read the way services/swap-flows.ts bridgeDeliveryOutcome
 * reads it: DONE with PARTIAL/REFUNDED means the deposit did not run and the
 * bridge paid out instead; FAILED is a failure; any other DONE is delivered.
 */
async function waitForDelivery(txHash: string, tool?: string) {
  const until = Date.now() + DELIVERY_TIMEOUT_MS;
  let last = '';
  for (;;) {
    let s = null;
    try {
      s = await lifi.getSwapStatus({ txHash, fromChainId: SOURCE_CHAIN, toChainId: DEST_CHAIN, ...(tool ? { bridge: tool } : {}) });
    } catch (e) {
      log(`  status read failed, retrying: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
    }
    if (s) {
      const line = `${s.status}${s.substatus ? `/${s.substatus}` : ''}`;
      if (line !== last) { log(`  LiFi ${line}${s.substatusMessage ? `: ${s.substatusMessage}` : ''}`); last = line; }
      if (s.status === 'FAILED') fail(`the bridge leg FAILED: ${s.substatusMessage ?? s.substatus ?? 'no detail'}`);
      if (s.status === 'DONE') {
        const sub = String(s.substatus ?? '').toUpperCase();
        if (sub === 'PARTIAL' || sub === 'REFUNDED') {
          if (s.receiving?.txHash) recordTx(`bridge payout (${sub})`, s.receiving.chainId ?? DEST_CHAIN, s.receiving.txHash);
          fail(`the ${DEST_NAME} deposit did not run: LiFi ${sub}, the bridge ${sub === 'REFUNDED' ? 'refunded on the source chain' : 'paid the fallback address'} instead`);
        }
        if (!s.receiving?.txHash) fail('LiFi reports DONE without a receiving transaction');
        return s;
      }
    }
    if (Date.now() > until) fail(`no delivery verdict within ${DELIVERY_TIMEOUT_MS / 60_000} minutes (last: ${last || 'none'})`);
    await sleep(15_000);
  }
}

/**
 * A little ETH on the destination for the registration there, bridged from OP with a
 * plain LiFi route (the slow run's bridgeGasToDestination, unchanged checks).
 */
async function bridgeGasToDest() {
  const q = new URLSearchParams({
    fromChain: String(SOURCE_CHAIN), toChain: String(DEST_CHAIN),
    fromToken: '0x0000000000000000000000000000000000000000', toToken: '0x0000000000000000000000000000000000000000',
    fromAmount: BRIDGE_AMOUNT.toString(), fromAddress: acct.address, toAddress: acct.address,
  });
  const res = await fetch(`https://li.quest/v1/quote?${q}`);
  const quote = await res.json().catch(() => null);
  const tx = quote?.transactionRequest;
  if (!res.ok || !tx) fail(`no LiFi route to bridge ETH to ${DEST_NAME}: ${res.status} ${quote?.message ?? ''}`);
  if (String(tx.to).toLowerCase() !== LIFI_DIAMOND) fail(`LiFi bridge tx targets ${tx.to}, expected the LiFi diamond`);
  if (BigInt(tx.value) !== BRIDGE_AMOUNT) fail(`LiFi bridge tx value ${tx.value} != ${BRIDGE_AMOUNT}`);
  if (Number(tx.chainId) !== SOURCE_CHAIN) fail(`LiFi bridge tx is for chain ${tx.chainId}`);
  const out = BigInt(quote.estimate?.toAmountMin ?? 0);
  if (out < (BRIDGE_AMOUNT * 8n) / 10n) fail(`LiFi bridge would deliver only ${formatEther(out)} ETH`);
  log(`  bridging ${formatEther(BRIDGE_AMOUNT)} ETH via ${quote.tool}`);
  const hash = await opWallet.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value) });
  recordTx(`gas bridge to ${DEST_NAME}`, SOURCE_CHAIN, hash);
  const receipt = await op.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') fail(`bridge tx ${hash} reverted on Optimism`);
  const until = Date.now() + BRIDGE_GAS_TIMEOUT_MS;
  for (;;) {
    const now = await eth.getBalance({ address: acct.address });
    if (now >= DEST_GAS_MIN) { log(`  bridged: ${formatEther(now)} ETH on ${DEST_NAME}`); return; }
    if (Date.now() > until) fail(`bridge ${hash} did not arrive on ${DEST_NAME} within ${BRIDGE_GAS_TIMEOUT_MS / 60_000} minutes`);
    await sleep(15_000);
  }
}

async function closeResources() {
  // snarkjs keeps a bn128 curve with worker threads on globalThis after proving.
  try { await globalThis.curve_bn128?.terminate?.(); } catch { /* best effort */ }
}

function printSummary() {
  const total = Date.now() - started;
  console.log('\n=== crosschain-swap-fast timeline ===');
  for (const t of timeline) console.log(redact(`${t.ok ? 'ok  ' : 'FAIL'} ${secs(t.ms).padStart(8)}  ${t.name}${t.note ? `  (${t.note})` : ''}`));
  console.log(`     ${secs(total).padStart(8)}  total`);
  console.log('=== transactions ===');
  if (!txs.length) console.log('(none sent)');
  for (const t of txs) console.log(`chain ${String(t.chainId).padEnd(3)} ${t.hash}  ${t.what}`);
}
