// Mother-account funding for the CI e2e run.
//
// CI must not carry a long-lived key that the tests spend from directly: every
// run mints a THROWAWAY account, the mother funds it, the tests spend it, and
// whatever is left is swept back. So a leaked run log costs at most the float,
// and a stuck test cannot drain the mother.
//
// Plain viem, no browser, so this stays type-checked and can be exercised on its
// own (`bun scripts/e2e/funding.ts check`).
import {
  createPublicClient, createWalletClient, formatEther, http, parseEther,
  type Address, type PublicClient,
} from 'viem';
import { sepolia } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { existsSync, readFileSync } from 'node:fs';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

/**
 * Env with a .env fallback.
 *
 * CI passes secrets as real environment variables; local runs keep them in .env
 * (and under safewrap the process env is cleared, so the file is the only
 * source). Process env wins so CI can override anything checked in.
 */
export function envValue(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  const p = `${ROOT}/.env`;
  if (!existsSync(p)) return undefined;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)$/);
    if (m && m[1] === name) return m[2]!.trim().replace(/^["']|["']$/g, '');
  }
  return undefined;
}

export function rpcUrl(): string {
  const key = envValue('EXPO_PUBLIC_ALCHEMY_KEY');
  const url = key ? `https://eth-sepolia.g.alchemy.com/v2/${key}` : envValue('EXPO_PUBLIC_RPC_URL');
  if (!url) throw new Error('no RPC: set EXPO_PUBLIC_ALCHEMY_KEY or EXPO_PUBLIC_RPC_URL');
  return url;
}

export const client = (): PublicClient => createPublicClient({ chain: sepolia, transport: http(rpcUrl()) });

/** An account from a raw private key: how CI passes its secrets. */
export function accountFromKey(key: string): PrivateKeyAccount {
  return privateKeyToAccount(`0x${key.replace(/^0x/, '')}` as `0x${string}`);
}

/** The funding account. A is the funder; E2E_MOTHER_PK stays accepted as an alias. */
export function funderAccount(): PrivateKeyAccount {
  const pk = envValue('E2E_ACCOUNT_A_PK') ?? envValue('E2E_MOTHER_PK') ?? envValue('DEV_PK');
  if (!pk) throw new Error('E2E_ACCOUNT_A_PK is not set (CI secret), and no DEV_PK fallback in .env');
  return accountFromKey(pk);
}

/**
 * A fresh account for this run only.
 *
 * The key is returned alongside the account because the browser harness needs it
 * to sign, but it is never written to disk and never logged: only the address is
 * printed, so a public CI log cannot be used to sweep the float.
 */
export function mintEphemeral(): { privateKey: `0x${string}`; account: PrivateKeyAccount } {
  const privateKey = generatePrivateKey();
  return { privateKey, account: privateKeyToAccount(privateKey) };
}

/**
 * Refuse to start when the mother cannot cover the run.
 *
 * This is the check that makes a dry mother fail the build loudly, instead of
 * every flow failing later for reasons that look like app bugs.
 */
export async function requireFunds(
  who: PrivateKeyAccount,
  needEth: string,
  label = 'funding account',
): Promise<bigint> {
  const need = parseEther(needEth);
  const have = await client().getBalance({ address: who.address });
  console.log(`${label} ${who.address} holds ${formatEther(have)} ETH, run needs ${needEth} ETH`);
  if (have < need) {
    throw new Error(
      `${label.toUpperCase()} OUT OF FUNDS: ${who.address} holds ${formatEther(have)} ETH but the run needs ${needEth} ETH. `
      + 'Top it up on Sepolia and re-run.',
    );
  }
  return have;
}

/** Kept for callers that still say "mother". */
export const requireMotherFunds = requireFunds;

/** Move `amountEth` from the mother to the throwaway account and wait for it. */
export async function fundAccount(
  mother: PrivateKeyAccount,
  to: Address,
  amountEth: string,
): Promise<`0x${string}`> {
  const wallet = createWalletClient({ account: mother, chain: sepolia, transport: http(rpcUrl()) });
  const hash = await wallet.sendTransaction({ to, value: parseEther(amountEth) });
  console.log(`funding ${to} with ${amountEth} ETH: ${hash}`);
  const r = await client().waitForTransactionReceipt({ hash, timeout: 300_000 });
  if (r.status !== 'success') throw new Error(`funding transfer failed: ${hash}`);
  console.log(`funded in block ${r.blockNumber}`);
  return hash;
}

/**
 * One sweep: `hash` is the first transfer, `hashes` every transfer it sent (a
 * capped sweep sends a follow-up), `status` the first one's receipt, and
 * `value` only what CONFIRMED transfers moved.
 */
export type SweepResult = { hash: `0x${string}`; hashes: `0x${string}`[]; status: 'success' | 'reverted'; value: bigint };

/**
 * An insufficient-funds refusal, and the balance the refusing node holds when
 * it says. Geth: "insufficient funds for gas * price + value: have N want M".
 * Others: "balance N, need M" (or "balance N, tx cost M"). A refusal with no
 * numbers returns have: null, and the caller re-reads the balance.
 */
export function insufficientFundsRefusal(error: unknown): { have: bigint | null } | null {
  const text = String((error as Error)?.message ?? error) + ' ' + String((error as { details?: unknown })?.details ?? '');
  if (!/insufficient (funds|balance)/i.test(text)) return null;
  const have = /\bhave (\d+)/i.exec(text) ?? /\bbalance:? (\d+)/i.exec(text);
  return { have: have ? BigInt(have[1]) : null };
}

/**
 * Send everything the throwaway account still holds back to the mother.
 *
 * Gas is subtracted from the value, so the account ends at (near) zero rather
 * than reverting for insufficient funds. Returns null when the remainder cannot
 * even pay for its own transfer, which is normal and not a failure.
 */
export async function sweepTo(
  child: PrivateKeyAccount,
  mother: Address,
  /** Leave this much behind, for an account that stays in service. */
  keepWei: bigint = 0n,
  /** Internal: the follow-up sweep of a capped one does not chain again. */
  sweepRest = true,
): Promise<SweepResult | null> {
  const pub = client();
  const wallet = createWalletClient({ account: child, chain: sepolia, transport: http(rpcUrl()) });
  const gas = 21_000n;
  // The RPC is load-balanced: the balance read and the send can hit different
  // nodes. Run 37776352381 read 0.007997 ETH (after the ragequit landed) and the
  // send's node still held 0.006998, so the value was refused with "insufficient
  // funds for gas * price + value". Each attempt re-reads the balance and fees,
  // and a refusal's own "have N" bounds the next attempt.
  let ceiling: bigint | null = null;
  let sent: { hash: `0x${string}`; value: bigint } | null = null;
  for (let attempt = 1; attempt <= 5 && !sent; attempt += 1) {
    const read = await pub.getBalance({ address: child.address });
    const total = ceiling !== null && ceiling < read ? ceiling : read;
    const balance = total > keepWei ? total - keepWei : 0n;
    if (balance === 0n) { console.log('sweep: throwaway account is already empty'); return null; }
    const fees = await pub.estimateFeesPerGas();
    // A little headroom: the base fee can rise between estimate and inclusion, and
    // an underpriced sweep would strand the float instead of returning it.
    const maxFee = (fees.maxFeePerGas ?? 1_000_000_000n) * 2n;
    const cost = gas * maxFee;
    if (balance <= cost) {
      console.log(`sweep: ${formatEther(balance)} ETH left, less than the ${formatEther(cost)} ETH it would cost to move`);
      return null;
    }
    const value = balance - cost;
    try {
      const hash = await wallet.sendTransaction({
        to: mother,
        value,
        gas,
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 1_000_000n,
      });
      sent = { hash, value };
    } catch (error) {
      const refusal = insufficientFundsRefusal(error);
      if (!refusal || attempt === 5) throw error;
      if (refusal.have !== null) {
        ceiling = refusal.have;
        console.log(`sweep: node reports ${formatEther(ceiling)} ETH, not ${formatEther(read)}, retrying from that`);
      } else {
        console.log('sweep: refused for insufficient funds with no balance given, re-reading and retrying');
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (!sent) return null;
  const { hash, value } = sent;
  console.log(`sweeping ${formatEther(value)} ETH back to ${mother}: ${hash}`);
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
  console.log(`sweep ${r.status} in block ${r.blockNumber}`);
  // A refusal's "have N" can come from a node BEHIND the real balance, so a
  // capped sweep may leave the difference behind. Sweep once more from a fresh
  // read; it returns null when what is left cannot pay for its own transfer.
  const result: SweepResult = { hash, hashes: [hash], status: r.status, value: r.status === 'success' ? value : 0n };
  if (sweepRest && ceiling !== null && r.status === 'success') {
    const rest = await sweepTo(child, mother, keepWei, false);
    // Counted only once its own receipt succeeded; its hash is listed either way.
    if (rest) {
      result.hashes.push(rest.hash);
      if (rest.status === 'success') result.value += rest.value;
    }
  }
  return result;
}

// `bun scripts/e2e/funding.ts check` prints the mother's address and balance
// without spending anything, which is the quickest way to see whether CI would
// refuse to start.
if (process.argv[2] === 'check') {
  const funder = funderAccount();
  const have = await client().getBalance({ address: funder.address });
  console.log(`funder (account A): ${funder.address}`);
  console.log(`balance: ${formatEther(have)} ETH`);
  const need = process.argv[3] ?? '0.02';
  console.log(have >= parseEther(need) ? `enough for a ${need} ETH run` : `NOT enough for a ${need} ETH run`);
}

// `bun scripts/e2e/funding.ts mint [eth]` mints a key, funds it from the mother,
// and prints the E2E_PK line, which is what the CI fresh-account step does before
// it shields. Useful on its own when that step needs to be reproduced by hand.
if (process.argv[2] === 'mint') {
  const amount = process.argv[3] ?? '0.012';
  const fresh = mintEphemeral();
  await fundAccount(funderAccount(), fresh.account.address, amount);
  console.log(`fresh address: ${fresh.account.address}`);
  console.log(`E2E_PK=${fresh.privateKey}`);
}

// `bun scripts/e2e/funding.ts sweep <privateKey>` returns whatever is left in a
// throwaway key to the mother, which is what CI's finally block does.
if (process.argv[2] === 'sweep') {
  const key = process.argv[3];
  if (!key) { console.error('usage: funding.ts sweep <privateKey> [keepEth]'); process.exit(64); }
  const keep = process.argv[4] ? parseEther(process.argv[4]) : 0n;
  await sweepTo(accountFromKey(key), funderAccount().address, keep);
}

/** Nothing this suite shields exceeds this (MAX_ETH in sepolia.ts). */
export const FIXTURE_NOTE_ETH = '0.001';
/**
 * Fee room a payer's note keeps beyond the payment. Measured, not assumed: the
 * relayed spends of 2026-10-08 paid 0.00000125 ETH (withdrawal, runs
 * 37725929454, 37767164114, 37776352381) and 0.00000085 ETH (transfer, run
 * 37725929454). 0.0003 is over 200 times that. The 0.0006 fee of 2026-08-21
 * (sepolia.ts SPEND_ETH) was Sepolia gas at the time; a spike back to it shows
 * up as "Insufficient value", never as a silent pass.
 */
export const PAYMENT_FEE_RESERVE_ETH = '0.0003';
/** Headroom over the app's request floor, for the price moving within a run. */
const REQUEST_FLOOR_MARGIN = 1.25;

const SEPOLIA_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const ASSETS_ABI = [{
  type: 'function', name: 'assets', stateMutability: 'view',
  inputs: [{ name: '', type: 'address' }],
  outputs: [{ name: '', type: 'tuple', components: [
    { name: 'enabled', type: 'bool' }, { name: 'minAmount', type: 'uint256' },
    { name: 'vettingFeeBPS', type: 'uint256' }, { name: 'maxRelayFee', type: 'uint256' },
  ] }],
}] as const;

/**
 * The payment-request amount, derived the way the app judges it.
 *
 * The app refuses a request worth less than PAYMENT_REQUEST_MIN_USD at its ETH
 * price (on testnet the ASP prices ETH at 0 and the app falls back to the
 * Alchemy price, so that is the price read here). The payment must then fit
 * one capped fixture note after the entrypoint's vetting fee, with
 * PAYMENT_FEE_RESERVE_ETH to spare. When it cannot, this throws and says why,
 * instead of letting the request be refused on screen.
 */
export async function paymentRequestEth(): Promise<string> {
  const { PAYMENT_REQUEST_MIN_USD } = await import('../../services/payment-request-bounds');
  const key = envValue('EXPO_PUBLIC_ALCHEMY_KEY');
  if (!key) throw new Error('payment request amount: EXPO_PUBLIC_ALCHEMY_KEY is needed to price ETH as the app does');
  const res = await fetch(`https://api.g.alchemy.com/prices/v1/${key}/tokens/by-symbol?symbols=ETH`);
  const json = res.ok ? await res.json() as { data?: { prices?: { currency: string; value: string }[] }[] } : {};
  const price = Number(json.data?.[0]?.prices?.find((p) => p.currency.toLowerCase() === 'usd')?.value ?? 0);
  if (!(price > 0)) throw new Error(`payment request amount: no ETH price (HTTP ${res.status})`);

  // Highest vetting fee among the Sepolia entrypoints the ASP lists: the one
  // the app deposits through is among them, and the larger fee is the safe side.
  const asp = (envValue('EXPO_PUBLIC_ASP_URL') ?? 'https://api-dev.0xbow.io').replace(/\/$/, '');
  // Both feed shapes (flat pools[] and the legacy chain map), via the app's own normalizer.
  const { normalizeEntrypoints } = await import('../../services/entrypoints-normalize');
  const feed = normalizeEntrypoints(await (await fetch(`${asp}/global/public/entrypoints`)).json());
  const entrypoints = feed.pools.filter((p) => String(p.chainId) === String(sepolia.id)).map((p) => p.entrypoint as Address);
  if (!entrypoints.length) throw new Error('payment request amount: the ASP lists no Sepolia entrypoint');
  let bps = 0n;
  for (const address of entrypoints) {
    const asset = await client().readContract({ address, abi: ASSETS_ABI, functionName: 'assets', args: [SEPOLIA_NATIVE] });
    if (asset.enabled && asset.vettingFeeBPS > bps) bps = asset.vettingFeeBPS;
  }

  const step = 10n ** 13n; // 0.00001 ETH
  const floorWei = parseEther((PAYMENT_REQUEST_MIN_USD * REQUEST_FLOOR_MARGIN / price).toFixed(18));
  const amountWei = ((floorWei + step - 1n) / step) * step;
  const noteWei = parseEther(FIXTURE_NOTE_ETH) * (10_000n - bps) / 10_000n;
  const neededWei = amountWei + parseEther(PAYMENT_FEE_RESERVE_ETH);
  const amount = formatEther(amountWei);
  console.log(`payment request: ${amount} ETH (floor $${PAYMENT_REQUEST_MIN_USD} x ${REQUEST_FLOOR_MARGIN} at ETH $${price}), note ${formatEther(noteWei)} ETH after ${bps} bps vetting, reserve ${PAYMENT_FEE_RESERVE_ETH}`);
  if (neededWei > noteWei) {
    throw new Error(`payment request amount: ${amount} ETH (the app's $${PAYMENT_REQUEST_MIN_USD} floor x ${REQUEST_FLOOR_MARGIN} at ETH $${price}) plus the ${PAYMENT_FEE_RESERVE_ETH} ETH fee reserve does not fit a ${FIXTURE_NOTE_ETH} ETH fixture note worth ${formatEther(noteWei)} ETH after ${bps} bps vetting. Raising the cap is a product-owner decision.`);
  }
  return amount;
}
