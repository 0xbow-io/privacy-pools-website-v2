// @ts-nocheck - uses Bun runtime APIs (Bun.spawn) and .ts import specifiers; the
// repo type-checks against a minimal Bun stub that does not declare them.
//
// Full funded Sepolia suite: bun scripts/e2e/ci.ts.
// A funds fixtures; B pays requests. Both retain their registered keys and notes.
// Derived accounts isolate consolidation and batch fixtures. A fresh account
// proves registration, shielding, and ragequit; cleanup returns its leftover gas.
import { formatEther, keccak256, parseEther, stringToBytes } from 'viem';
import { existsSync, writeFileSync } from 'node:fs';
import { accountFromKey, client, envValue, fundAccount, mintEphemeral, paymentRequestEth, requireFunds, sweepTo } from './funding';

// 0.004 was not enough: a FIRST deposit from a brand-new key also pays for the
// keystore-registration transaction, so the app capped the shieldable amount at
// 0.00066 of it ("Leave room for the vetting fee and gas") and the deposit never
// went out. The reserve it held back measured about 0.0033, and the run itself
// spent 0.002 (the deposit plus gas for two transactions), so this leaves the
// cap several times clear of FRESH_SHIELD_ETH. Nearly all of it comes back: the
// fresh key ragequits its deposit and the sweep returns the remainder.
const FUND_ETH = envValue('E2E_FUND_ETH') ?? '0.008';
const FRESH_SHIELD_ETH = envValue('E2E_FRESH_SHIELD_ETH') ?? '0.001';
// A run advances FUND_ETH to the fresh key (most of it comes back via ragequit +
// sweep), plus the capped shield/withdraw/send and payment-request amounts and
// the gas for its own transactions.
const MIN_FUNDER_ETH = envValue('E2E_FUNDER_MIN_ETH') ?? '0.04';
// A payment request under PAYMENT_REQUEST_MIN_USD (services/payment-request-bounds.ts,
// $1.15 since 2026-09-21) is refused with a toast and never makes a link. The
// fixed 0.0002 ETH (about $0.50) failed every run since. The amount is now
// derived from the app's ETH price and that floor, and the run stops here, saying
// why, when it no longer fits a capped fixture note.
const BASE = envValue('PROBE_URL') ?? 'http://localhost:8081';
const ROOT = new URL('../..', import.meta.url).pathname;

// GROUPS. With no group, everything runs in sequence on one machine, as it
// always has. CI runs `fund` first, then core, payment and fixtures as
// parallel jobs (E2E_GROUP), each its own runner, browser and dev server.
//
// The one cross-group rule: PoolVault checks a proof's associationSetRoot
// against the registry's LATEST root, which keeps no history, so a deposit
// approved while another group proves makes that spend revert
// (InvalidASPRoot). The app re-proves once on withdraw and payment, but not on
// send, consolidation or batch. So a parallel run has three phases, held
// together across runners by E2E_PHASE_DIR flags that the workflow sets once
// every group has reached the same point (scripts/e2e/group-barrier.ts):
//   1. seed: each group deposits its fixtures and waits for their approval.
//   2. spend: no group deposits, so nothing is approved under another's proof.
//   3. after: the root-rotating steps (deposit-for, the fresh key's shield and
//      ragequit), in core only, once every group has stopped proving.
// Wallets and notes never overlap between groups:
//   fund      A tops up B and the fixtures treasury, before any group starts.
//   core      A: shield/withdraw/send (privacy gates), then the after phase.
//             The only group that spends A's notes or sends from A's wallet.
//   payment   B pays A's request and an unregistered payee; viewing key and
//             pool page (read-only). Spends B's notes; A only receives.
//   fixtures  consolidate and batch on accounts derived from a treasury that
//             is itself derived from A's key, so its address never churns.
const GROUPS = ['fund', 'core', 'payment', 'fixtures'] as const;
const GROUP = envValue('E2E_GROUP') ?? process.argv[2] ?? 'all';
if (GROUP !== 'all' && !GROUPS.includes(GROUP as never)) {
  throw new Error(`unknown E2E_GROUP "${GROUP}" (one of: all, ${GROUPS.join(', ')})`);
}
const runs = (group: typeof GROUPS[number]) => GROUP === 'all' || GROUP === group;
const PHASE_DIR = process.env.E2E_PHASE_DIR;
const phaseFlag = (name: string) => { if (PHASE_DIR) writeFileSync(`${PHASE_DIR}/${name}`, ''); };
const phaseGate = async (name: string) => {
  if (!PHASE_DIR) return;
  console.log(`===== waiting for every group: ${name} =====`);
  while (!existsSync(`${PHASE_DIR}/${name}`)) {
    if (existsSync(`${PHASE_DIR}/abort`)) throw new Error(`another group failed before ${name}; stopping without spending`);
    await Bun.sleep(2000);
  }
};

const aKey = envValue('E2E_ACCOUNT_A_PK') ?? envValue('DEV_PK');
const bKey = envValue('E2E_ACCOUNT_B_PK') ?? envValue('DEV_PK2');
if (!aKey) throw new Error('missing secret E2E_ACCOUNT_A_PK (or DEV_PK locally)');
if (!bKey && GROUP !== 'fixtures') throw new Error('missing secret E2E_ACCOUNT_B_PK (or DEV_PK2 locally)');
const A = accountFromKey(aKey);
const B = bKey ? accountFromKey(bKey) : null;
console.log(`group: ${GROUP}`);
console.log(`account A (payee, funder): ${A.address}`);
if (B) console.log(`account B (payer, counterparty): ${B.address}`);
const treasuryKey = GROUP === 'all' ? aKey
  : keccak256(stringToBytes(`0x${aKey.replace(/^0x/, '')}:ppv2-e2e-fixtures-treasury-v1`));
const treasury = accountFromKey(treasuryKey);
if (GROUP !== 'all') console.log(`fixtures treasury (derived from A): ${treasury.address}`);
// A payment request under PAYMENT_REQUEST_MIN_USD is refused; see above.
const REQUEST_ETH = runs('payment') ? envValue('E2E_REQUEST_ETH') ?? await paymentRequestEth() : '';
const prepared = new Map();
const start = (label: string, args: string[], env: Record<string, string>, prepare = false) => {
  console.log(`\n===== ${label}${prepare ? ': preparing fixtures' : ''} =====`);
  const started = Date.now();
  const seeded = Promise.withResolvers<boolean>();
  const ready = Promise.withResolvers<boolean>();
  const proc = Bun.spawn(['bun', ...args], {
    cwd: ROOT,
    env: { ...process.env, PROBE_URL: BASE, ...env, E2E_OVERLAP_FIXTURES: prepare ? '1' : '0' },
    stdout: 'inherit',
    stderr: 'inherit',
    ...(prepare ? { ipc(message) {
      if (message === 'seeded') seeded.resolve(true);
      if (message === 'ready') ready.resolve(true);
      console.log(`===== ${label}: fixtures ${message} (${((Date.now() - started) / 1000).toFixed(1)}s) =====`);
    } } : {}),
  });
  const done = proc.exited.then(code => {
    seeded.resolve(false);
    ready.resolve(false);
    console.log(`===== ${label}: exit ${code} (${((Date.now() - started) / 1000).toFixed(1)}s including preparation) =====`);
    return code === 0;
  });
  return { proc, done, seeded: seeded.promise, ready: ready.promise };
};
const prepare = async (label: string, args: string[], env: Record<string, string>) => {
  const journey = start(label, args, env, true);
  prepared.set(args[0], journey);
  if (!(await journey.seeded)) throw new Error(`${label}: fixture submission failed`);
};
const awaitPrepared = async () => {
  if (!(await Promise.all([...prepared.values()].map(journey => journey.ready))).every(Boolean)) {
    throw new Error('Fixture approval failed; no proof-based journeys will run');
  }
  console.log('===== Fixture wave approved; spending =====');
};
const run = async (label: string, args: string[], env: Record<string, string>) => {
  const journey = prepared.get(args[0]);
  if (!journey) return start(label, args, env).done;
  console.log(`===== ${label}: executing after shared approval barrier =====`);
  prepared.delete(args[0]);
  journey.proc.send('run');
  return journey.done;
};

if (runs('fund') || runs('core')) await requireFunds(A, MIN_FUNDER_ETH, 'account A');

// A is the treasury: it holds the float and hands out what the other fixed
// accounts need, so topping up A alone keeps the suite running. B pays no gas on
// the relayed paths but does spend some over time, and a B that runs dry fails
// the payment-request step for a reason that has nothing to do with the product.
// Two 0.001 ETH fixtures, their transaction fees, and the form's gas reserve.
const ACCOUNT_FLOOR_ETH = envValue('E2E_ACCOUNT_FLOOR_ETH') ?? '0.008';
const ACCOUNT_TARGET_ETH = envValue('E2E_ACCOUNT_TARGET_ETH') ?? '0.01';
// The fixtures treasury covers the consolidation (0.01) and batch (0.016) accounts.
const TREASURY_FLOOR_ETH = envValue('E2E_TREASURY_FLOOR_ETH') ?? '0.03';
const TREASURY_TARGET_ETH = envValue('E2E_TREASURY_TARGET_ETH') ?? '0.04';
const topUps = [] as [string, `0x${string}`, string, string][];
if (runs('fund') && B) topUps.push(['account B', B.address, ACCOUNT_FLOOR_ETH, ACCOUNT_TARGET_ETH]);
if (GROUP === 'fund') topUps.push(['fixtures treasury', treasury.address, TREASURY_FLOOR_ETH, TREASURY_TARGET_ETH]);
const sends = [] as [string, `0x${string}`, bigint, bigint][];
for (const [name, address, floor, target] of topUps) {
  const have = await client().getBalance({ address });
  if (have < parseEther(floor)) sends.push([name, address, have, parseEther(target) - have]);
}
// A must cover every top-up it is about to send, not just the run float, plus
// the run itself when this is a sequential run (core spends from A too).
if (sends.length) {
  const total = sends.reduce((sum, [, , , value]) => sum + value, 0n) + parseEther('0.002') * BigInt(sends.length);
  await requireFunds(A, formatEther(total + (GROUP === 'all' ? parseEther(MIN_FUNDER_ETH) : 0n)), 'account A (top-ups)');
}
for (const [name, address, have, value] of sends) {
  console.log(`${name} is thin (${formatEther(have)} ETH), topping it up from A`);
  await fundAccount(A, address, formatEther(value));
}
if (GROUP === 'fund') { console.log('funding done'); process.exit(0); }
if (GROUP === 'fixtures') await requireFunds(treasury, TREASURY_FLOOR_ETH, 'fixtures treasury (the fund job tops it up)');

const outcomes: Record<string, boolean> = {};
const { privateKey: freshKey, account: fresh } = mintEphemeral();
const CORE = ['scripts/e2e/sepolia.ts', 'all', '0.001'];
const PAYMENT = ['scripts/e2e/payment-request.ts', REQUEST_ETH, '--prepare-next-payment'];
let freshFunded = false;

try {
  // Phase 1: seed. Locally (no group) at most two fixture groups are alive per
  // wave, keeping browser memory bounded; in CI each runner has one or two.
  if (runs('core')) await prepare('shield, withdraw and send', CORE, { E2E_PK: aKey, E2E_COUNTERPARTY: B.address });
  if (runs('payment')) await prepare('payment request: create, pay, claim', PAYMENT, { E2E_PAYEE_PK: aKey, E2E_PAYER_PK: bKey });
  if (prepared.size) await awaitPrepared();
  if (GROUP === 'fixtures') {
    // consolidate.ts and batch-withdraw.ts derive their accounts from the key
    // they are handed and fund them from it.
    await prepare('consolidate: fold small notes of one lineage', ['scripts/e2e/consolidate.ts'], { E2E_ACCOUNT_A_PK: treasuryKey });
    await prepare('batch withdrawal via account C', ['scripts/e2e/batch-withdraw.ts'], { E2E_ACCOUNT_A_PK: treasuryKey });
    await awaitPrepared();
  }
  phaseFlag('seeded');
  await phaseGate('go-spend');

  // Phase 2: spend.
  if (runs('core')) outcomes['shield/withdraw/send (fixed accounts)'] = await run('shield, withdraw and send', CORE,
    { E2E_PK: aKey, E2E_COUNTERPARTY: B.address });
  if (runs('payment')) {
    // Same fee arithmetic as the spends: the relayer fee comes out of the note
    // being spent, so the request stays well inside one.
    outcomes['payment request (A -> B -> A)'] = await run('payment request: create, pay, claim', PAYMENT,
      { E2E_PAYEE_PK: aKey, E2E_PAYER_PK: bKey });
    // Payment request with a FRESH UNREGISTERED payee every run (Mike, QA
    // 2026-08-25): the payer's success must be explicit and terminal (not a
    // reset), and the payee must discover the payment automatically. The payee
    // key is minted inside the script and needs no funds; the tiny payment
    // stays in the pool as testnet dust (the key is printed for recovery).
    outcomes['payment request to an UNREGISTERED payee'] = await run('payment request: unregistered payee',
      ['scripts/e2e/payment-request-unregistered.ts', REQUEST_ETH], { E2E_PAYER_PK: bKey });
  }
  if (runs('fixtures')) {
    if (GROUP === 'all') {
      // The second local wave.
      await prepare('consolidate: fold small notes of one lineage', ['scripts/e2e/consolidate.ts'], { E2E_ACCOUNT_A_PK: treasuryKey });
      await prepare('batch withdrawal via account C', ['scripts/e2e/batch-withdraw.ts'], { E2E_ACCOUNT_A_PK: treasuryKey });
      await awaitPrepared();
    }
    // Same-label dust consolidation: fold the 2..5 smallest notes of one
    // lineage into a fresh note via a relayed self-transfer.
    outcomes['consolidate small notes (same lineage)'] = await run('consolidate: fold small notes of one lineage',
      ['scripts/e2e/consolidate.ts'], { E2E_ACCOUNT_A_PK: treasuryKey });
    // Batch withdrawal (N deposits -> N proofs -> one relayer call) on its own
    // derived account C.
    outcomes['batch withdrawal (multiple proofs)'] = await run('batch withdrawal via account C',
      ['scripts/e2e/batch-withdraw.ts'], { E2E_ACCOUNT_A_PK: treasuryKey });
  }
  if (runs('payment')) {
    // Read-only: the viewing key shown equals Keystore.viewingKeys(A), and the
    // pool page's deep links, not-found routes and chain-scoped statistics.
    outcomes['viewing key overview'] = await run('viewing key: overview matches the on-chain key',
      ['scripts/e2e/viewing-key.ts'], { E2E_ACCOUNT_A_PK: aKey });
    outcomes['pool deep links'] = await run('pool page: deep links, not-found, chain-scoped statistics',
      ['scripts/e2e/pool-deeplink.ts'], { E2E_ACCOUNT_A_PK: aKey });
  }
  phaseFlag('spent');

  // Phase 3: after. Only core, and only once no group is proving.
  if (runs('core')) {
    await phaseGate('go-after');
    // Deposit FOR another address: B discovers the registered-recipient note;
    // an unregistered recipient instead receives a one-time claim link.
    outcomes['deposit to another address (depositFor)'] = await run(
      'deposit-for: registered discovery and unregistered claim link',
      ['scripts/e2e/deposit-for.ts'],
      { E2E_ACCOUNT_A_PK: aKey, E2E_ACCOUNT_B_PK: bKey },
    );

    // The from-scratch path: a brand-new address, funded here, shielding once.
    console.log(`\nfresh account for this run: ${fresh.address}`);
    freshFunded = true;
    await fundAccount(A, fresh.address, FUND_ETH);
    const freshShielded = await run(
      'shield from scratch',
      ['scripts/e2e/sepolia.ts', 'shield', FRESH_SHIELD_ETH],
      { E2E_PK: freshKey },
    );
    outcomes['shield from a brand-new account'] = freshShielded;

    // Return that deposit with RAGEQUIT, not withdraw: ragequit exits to the
    // depositing address and needs no ASP approval, so a first-time account can
    // undo its own deposit inside the same run. A withdrawal could not - it would
    // have to wait for review - which would either strand the deposit in the pool
    // every run or make the gate flaky. This also gives ragequit its own coverage.
    if (freshShielded) {
      outcomes['ragequit back to the fresh account'] = await run(
        'ragequit the fresh deposit',
        ['scripts/e2e/sepolia.ts', 'ragequit'],
        { E2E_PK: freshKey },
      );
    }
  }
} finally {
  // Cancel only parked/approving journeys; an executing journey is always
  // awaited above, so cleanup never interrupts an unknown transaction outcome.
  for (const journey of prepared.values()) {
    if (journey.proc.exitCode === null) {
      try { journey.proc.send('cancel'); } catch { /* Already disconnected while closing its browser. */ }
    }
  }
  await Promise.all([...prepared.values()].map(journey => journey.done));
  // The deposit is only recoverable by the key that made it, and this key is
  // minted in-process and thrown away. So when the return path did not run or
  // did not work, print the key: without it a failed ragequit silently burns the
  // deposit, which is exactly what happened on 2026-08-19. Only on failure, and
  // only ever a throwaway testnet key holding test ETH.
  if (freshFunded) {
  const stranded = outcomes['ragequit back to the fresh account'] !== true;
  if (stranded) {
    console.log(`fresh key still holds a deposit in the pool. Recover it with:\n  E2E_PK=${freshKey} bun scripts/e2e/sepolia.ts ragequit`);
  }
  // The leftover gas goes home, EXCEPT when the deposit is still in the pool:
  // exiting it costs gas, and sweeping first left the printed recovery command
  // unable to run without re-funding the key.
  await sweepTo(fresh, A.address, stranded ? parseEther('0.0015') : 0n);
  const left = await client().getBalance({ address: fresh.address });
  console.log(`fresh account keeps ${formatEther(left)} ETH (dust below the cost of moving it)`);
  console.log(`account A now holds ${formatEther(await client().getBalance({ address: A.address }))} ETH`);
  }
}

console.log('\n=== CI SUMMARY ===');
for (const [name, ok] of Object.entries(outcomes)) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
if (!Object.keys(outcomes).length) { console.log(`group ${GROUP} ran no journeys`); process.exit(1); }
process.exit(Object.values(outcomes).every(Boolean) ? 0 : 1);
