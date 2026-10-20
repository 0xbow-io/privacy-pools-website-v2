import { describe, expect, test } from 'bun:test';
import { formatUnits, parseUnits } from 'viem';

import { decideViewingKeyPath, viewingKeyShortfallWei, viewingKeyTxPlan, VIEWING_KEY_GAS_LIMIT } from '../receive-setup';
import {
  CROSS_PAY_SHIELD_GAS_UNITS,
  DEPOSIT_GAS_BUDGET,
  maxShieldAmountWei,
  nativeDepositGasReserveWei,
  registrationOwnerUnchanged,
  planWalletTx,
  priceWalletTx,
  walletTxCostWei,
  walletTxFields,
  type FeeReadClient,
} from '../wallet-tx-fees';

const GWEI = 1_000_000_000n;
// Mike's prod deposit, 2026-10-13: 963,277 gas at 0.114 gwei.
const REAL_DEPOSIT_GAS = 963_277n;
const GAS_PRICE = 114_000_000n; // 0.114 gwei
const BASE_FEE = 100_000_000n;
const TIP = 14_000_000n;
const ETH_FLOOR = 100_000_000n;

function client(over: Partial<{ gas: bigint | Error; block: { baseFeePerGas?: bigint | null } | Error; tip: bigint | Error }> = {}): FeeReadClient & { calls: string[] } {
  const calls: string[] = [];
  const settle = <T,>(v: T | Error) => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v));
  return {
    calls,
    getGasPrice: async () => { calls.push('gasPrice'); return GAS_PRICE; },
    getBlock: () => { calls.push('block'); return settle(over.block ?? { baseFeePerGas: BASE_FEE }); },
    estimateMaxPriorityFeePerGas: () => { calls.push('tip'); return settle(over.tip ?? TIP); },
    estimateGas: () => { calls.push('estimateGas'); return settle(over.gas ?? REAL_DEPOSIT_GAS); },
  };
}

const TX = { account: '0x1111111111111111111111111111111111111111', to: '0x2222222222222222222222222222222222222222', data: '0x' } as const;

describe('wallet tx fee policy (DEV-542)', () => {
  test('deposit: gas limit is the estimate + 20%, near real usage, not a wallet tier', async () => {
    const plan = await priceWalletTx(client(), TX, DEPOSIT_GAS_BUDGET);
    expect(plan?.gas).toBe((REAL_DEPOSIT_GAS * 12n) / 10n);
    expect(Number(plan!.gas) / Number(REAL_DEPOSIT_GAS)).toBeLessThan(1.25);
  });

  test('EIP-1559 off Ethereum: tip is the node suggestion, maxFee = 2 x base + tip', async () => {
    const plan = await priceWalletTx(client(), TX, DEPOSIT_GAS_BUDGET, 10);
    expect(plan?.fees).toEqual({ maxFeePerGas: 2n * BASE_FEE + TIP, maxPriorityFeePerGas: TIP });
  });

  test('Ethereum: the tip is floored at 0.1 gwei so MetaMask does not flag it', async () => {
    const plan = await priceWalletTx(client(), TX, DEPOSIT_GAS_BUDGET, 1);
    expect(plan?.fees).toEqual({ maxFeePerGas: 2n * BASE_FEE + ETH_FLOOR, maxPriorityFeePerGas: ETH_FLOOR });
  });

  test('Ethereum deposit: the wallet estimate is within ~2x of the real fee, and far under MetaMask Market', async () => {
    const plan = await priceWalletTx(client(), TX, DEPOSIT_GAS_BUDGET, 1);
    const fees = plan!.fees as { maxPriorityFeePerGas: bigint };
    const paidBefore = REAL_DEPOSIT_GAS * GAS_PRICE; // 0.000110 ETH, the "low" tier Mike picked
    const walletEstimate = REAL_DEPOSIT_GAS * (BASE_FEE + fees.maxPriorityFeePerGas);
    expect(Number(walletEstimate) / Number(paidBefore)).toBeLessThanOrEqual(2);
    // MetaMask Market seen in QA: a ~2 gwei tip.
    const market = REAL_DEPOSIT_GAS * (BASE_FEE + 2n * GWEI);
    expect(Number(plan!.costWei) / Number(market)).toBeLessThan(0.2);
  });

  test('displayed cost equals gas x maxFee of the tx that is sent', async () => {
    const plan = await priceWalletTx(client(), TX, DEPOSIT_GAS_BUDGET, 1);
    const sent = walletTxFields(plan) as { gas: bigint; maxFeePerGas: bigint };
    expect(plan!.costWei).toBe(sent.gas * sent.maxFeePerGas);
  });

  test('a high node tip is kept and maxFee covers it', () => {
    const plan = planWalletTx({ gasEstimate: 50_000n, eip1559: true, priorityFeeWei: 2n * GWEI, baseFeeWei: BASE_FEE, gasPriceWei: GAS_PRICE });
    expect(plan.fees).toEqual({ maxFeePerGas: 2n * BASE_FEE + 2n * GWEI, maxPriorityFeePerGas: 2n * GWEI });
  });

  test('legacy chain (no base fee): gasPrice as is, cost = gas x gasPrice', async () => {
    const plan = await priceWalletTx(client({ block: { baseFeePerGas: null } }), TX, null);
    expect(plan?.fees).toEqual({ gasPrice: GAS_PRICE });
    const sent = walletTxFields(plan) as { gas: bigint; gasPrice: bigint };
    expect(sent.gas).toBe((REAL_DEPOSIT_GAS * 12n) / 10n);
  });

  test('unread block twice: no fee fields, the wallet prices it', async () => {
    const c = client({ block: new Error('down') });
    const plan = await priceWalletTx(c, TX, DEPOSIT_GAS_BUDGET);
    expect(plan?.fees).toBeNull();
    expect(c.calls.filter((x) => x === 'block')).toHaveLength(2);
  });

  test('estimate fails: deposit falls back to its budget, a kind without one leaves gas to the wallet', async () => {
    const dep = await priceWalletTx(client({ gas: new Error('x') }), TX, DEPOSIT_GAS_BUDGET);
    expect(dep?.gas).toBe((DEPOSIT_GAS_BUDGET * 12n) / 10n);
    expect(dep!.gas! >= REAL_DEPOSIT_GAS).toBe(true);
    const approve = await priceWalletTx(client({ gas: new Error('x') }), TX, null);
    expect(approve?.gas).toBeUndefined();
    expect(approve?.costWei).toBeNull();
    expect('gas' in walletTxFields(approve)).toBe(false);
    expect('maxFeePerGas' in walletTxFields(approve)).toBe(true);
  });

  test('approve / setAuthPolicy: estimated + 20% with the same fee caps', async () => {
    const plan = await priceWalletTx(client({ gas: 46_000n }), TX, null, 1);
    expect(plan?.gas).toBe(55_200n);
    expect(plan?.costWei).toBe(55_200n * (2n * BASE_FEE + ETH_FLOOR));
  });

  test('gas price read fails: null, the tx goes out as before', async () => {
    const c = client();
    c.getGasPrice = () => Promise.reject(new Error('rpc'));
    expect(await priceWalletTx(c, TX, DEPOSIT_GAS_BUDGET)).toBeNull();
    expect(walletTxFields(null)).toEqual({});
  });

  test('setViewingKey (#275 path) uses the same policy as every other wallet tx', () => {
    const input = { gasEstimate: 51_000n, eip1559: true, priorityFeeWei: TIP, baseFeeWei: BASE_FEE, minPriorityFeeWei: ETH_FLOOR, gasPriceWei: GAS_PRICE };
    const plan = viewingKeyTxPlan(input);
    const shared = planWalletTx({ ...input, fallbackGas: VIEWING_KEY_GAS_LIMIT });
    expect(plan).toEqual({ gas: shared.gas!, fees: shared.fees, costWei: shared.costWei! });
    // The gasPrice-only bound (pre-check, top-up) never under-states it.
    expect(walletTxCostWei({ gasUnits: 51_000n, gasPriceWei: GAS_PRICE, chainId: 1 }) >= plan.costWei).toBe(true);
  });

  test('Max ETH deposit leaves enough for value + gas x maxFee, even after a base-fee bump', () => {
    const balance = 10_000_000_000_000_000n; // 0.01 ETH
    const reserve = nativeDepositGasReserveWei({ gasPriceWei: GAS_PRICE, chainId: 1 });
    const value = balance - reserve;
    // The base fee keeps rising 12.5% a block for 4 blocks before the send re-prices.
    let base = BASE_FEE;
    for (let i = 0; i < 4; i++) base = (base * 1125n) / 1000n;
    const sent = planWalletTx({
      gasEstimate: REAL_DEPOSIT_GAS, eip1559: true, priorityFeeWei: TIP, baseFeeWei: base,
      minPriorityFeeWei: ETH_FLOOR, gasPriceWei: base + TIP,
    });
    expect(value + sent.costWei! <= balance).toBe(true);
    // And on a legacy chain whose gas price doubled.
    const legacy = planWalletTx({ gasEstimate: REAL_DEPOSIT_GAS, eip1559: false, gasPriceWei: 2n * GAS_PRICE });
    expect(balance - nativeDepositGasReserveWei({ gasPriceWei: GAS_PRICE, chainId: 56 }) + legacy.costWei! <= balance).toBe(true);
  });

  test('reserve is 1.6x the fallback send bound, not 2x on top', () => {
    const bound = walletTxCostWei({ gasUnits: DEPOSIT_GAS_BUDGET, gasPriceWei: GAS_PRICE, chainId: 1 });
    expect(nativeDepositGasReserveWei({ gasPriceWei: GAS_PRICE, chainId: 1 })).toBe((bound * 160n) / 100n);
    const crossPay = walletTxCostWei({ gasUnits: CROSS_PAY_SHIELD_GAS_UNITS, gasPriceWei: GAS_PRICE, chainId: 1 });
    expect(nativeDepositGasReserveWei({ gasPriceWei: GAS_PRICE, chainId: 1, crossPay: true })).toBe((crossPay * 160n) / 100n);
  });

  test('Max still covers the FALLBACK plan (no estimate) after four base-fee bumps', () => {
    const balance = 10_000_000_000_000_000n;
    let base = BASE_FEE;
    for (let i = 0; i < 4; i++) base = (base * 1125n) / 1000n;
    for (const chainId of [1, 10]) {
      const reserve = nativeDepositGasReserveWei({ gasPriceWei: BASE_FEE + TIP, chainId });
      const sent = planWalletTx({
        gasEstimate: null, fallbackGas: DEPOSIT_GAS_BUDGET, eip1559: true, priorityFeeWei: TIP, baseFeeWei: base,
        minPriorityFeeWei: chainId === 1 ? ETH_FLOOR : 0n, gasPriceWei: base + TIP,
      });
      expect(balance - reserve + sent.costWei! <= balance).toBe(true);
    }
  });

  test('a registration leg is only sent by the run owner on the run chain', () => {
    const owner = '0xAbC0000000000000000000000000000000000001';
    expect(registrationOwnerUnchanged({ owner, chainId: 1, current: { address: owner.toLowerCase(), chainId: 1 } })).toBe(true);
    // Switched account between legs: stop.
    expect(registrationOwnerUnchanged({ owner, chainId: 1, current: { address: '0x0000000000000000000000000000000000000002', chainId: 1 } })).toBe(false);
    // Switched network: stop.
    expect(registrationOwnerUnchanged({ owner, chainId: 1, current: { address: owner, chainId: 10 } })).toBe(false);
    // Disconnected: stop.
    expect(registrationOwnerUnchanged({ owner, chainId: 1, current: {} })).toBe(false);
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const modal = readFileSync(new URL('../../components/keystore-registration-modal-provider.tsx', import.meta.url), 'utf8');
    const check = modal.indexOf('if (!registrationOwnerUnchanged({ owner: runOwner, chainId, current: now })) {');
    // The marker is keyed by the identity captured at run start, never the
    // live (possibly switched) session.
    const captured = modal.indexOf('const runSetupKey = sessionAddress ?? address;');
    expect(captured).toBeGreaterThan(0);
    expect(captured).toBeLessThan(check);
    const partial = modal.indexOf("if (registrationLegSent) setReceiveSetup(runSetupKey, chainId, 'partial', 'local');", check);
    const send = modal.indexOf('sendTransactionAsync({ ...tx, account: runOwner as ViemAddress, ...walletTxFields(plan) })', check);
    expect(check).toBeGreaterThan(0);
    expect(partial).toBeGreaterThan(check);
    expect(send).toBeGreaterThan(partial);
  });

  test('Max amount passes the deposit check (Mike: 0.00564 ETH on Ethereum)', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
    // Both surfaces call the one helper with the same fee read.
    const hub = src('components/home/action-hub.tsx');
    const deposit = src('components/deposit-modal-provider.tsx');
    expect(hub).toContain('return maxShieldAmountWei({');
    expect(hub).toContain('gasPriceWei: hubFeeData?.gasPrice,');
    expect(deposit).toContain('const spendableBalanceWei = useMemo<bigint>(() => maxShieldAmountWei({');
    expect(deposit).toContain('gasPriceWei: feeData?.gasPrice,');
    // Same cross-pay mapping on both sides, and the validation compares the
    // entered amount against that spendable cap.
    expect(hub).toContain('crossPay: crossPayShield,');
    expect(deposit).toContain('crossPay: swapDepositActive,');
    expect(deposit).toContain('if (enteredWei > spendableBalanceWei) {');
    // The deposit modal's validation, as written there.
    const depositRejects = (enteredWei: bigint, spendableBalanceWei: bigint) => enteredWei > spendableBalanceWei;
    for (const crossPay of [false, true]) {
      for (const vettingFeeBps of [null, 0, 100]) {
        for (const gasPriceWei of [GAS_PRICE, 2n * GWEI, null]) {
          const balanceWei = 5_640_000_000_000_000n;
          // Shield tab: Max fills shieldMaxText = formatUnits(shieldMaxWei, 18).
          const hubMax = maxShieldAmountWei({ balanceWei, payIsNative: true, gasPriceWei, chainId: 1, crossPay, vettingFeeBps });
          const enteredWei = parseUnits(formatUnits(hubMax, 18), 18);
          // Deposit modal: spendable from ITS inputs (swapDepositActive = cross-pay).
          const spendable = maxShieldAmountWei({ balanceWei, payIsNative: true, gasPriceWei, chainId: 1, crossPay, vettingFeeBps });
          expect(depositRejects(enteredWei, spendable)).toBe(false);
          // One wei more is refused, so the check is live.
          if (hubMax > 0n) expect(depositRejects(enteredWei + 1n, spendable)).toBe(true);
          const fee = !crossPay && vettingFeeBps ? (hubMax * BigInt(vettingFeeBps)) / 10_000n : 0n;
          if (hubMax > 0n) expect(hubMax + fee + nativeDepositGasReserveWei({ gasPriceWei, chainId: 1, crossPay }) <= balanceWei).toBe(true);
        }
      }
    }
    // Mike's case: holds back less than the old ~0.00084 ETH.
    const held = 5_640_000_000_000_000n - maxShieldAmountWei({ balanceWei: 5_640_000_000_000_000n, payIsNative: true, gasPriceWei: GAS_PRICE, chainId: 1 });
    expect(held < 840_000_000_000_000n).toBe(true);
  });

  test('BNB Chain with baseFeePerGas 0 is priced legacy, never EIP-1559', async () => {
    for (const chainId of [56, 97]) {
      const c = client({ block: { baseFeePerGas: 0n } });
      const plan = await priceWalletTx(c, TX, null, chainId);
      expect(plan?.fees).toEqual({ gasPrice: GAS_PRICE });
      expect('maxFeePerGas' in walletTxFields(plan)).toBe(false);
      expect(c.calls).not.toContain('tip');
    }
  });

  test('a closed flow never reaches the wallet after the pricing await', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
    const modal = src('components/keystore-registration-modal-provider.tsx');
    const price = modal.indexOf('const plan = await priceWalletTx(');
    // Only the FIRST leg may be cancelled; once one went out the second proceeds.
    const guard = modal.indexOf('if (!registrationLegSent && !deliversToCaller()) throw new Error(REGISTRATION_CLOSED_BEFORE_PROMPT);', price);
    const mark = modal.indexOf('registrationLegSent = true;', guard);
    const send = modal.indexOf('sendTransactionAsync({ ...tx, account: runOwner as ViemAddress, ...walletTxFields(plan) })', price);
    expect(price).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(price);
    expect(mark).toBeGreaterThan(guard);
    expect(send).toBeGreaterThan(mark);
    const deposit = src('components/deposit-modal-provider.tsx');
    const dPrice = deposit.indexOf('await priceWalletTx(');
    const dGuard = deposit.indexOf('stillLive?.();', dPrice);
    const dSend = deposit.indexOf('return sendTransactionAsync({ ...tx, ...walletTxFields(plan) });', dPrice);
    expect(dGuard).toBeGreaterThan(dPrice);
    expect(dSend).toBeGreaterThan(dGuard);
    // Only the swap submit (whose own pre-send live() check sits right before
    // it) passes the guard; the prepared deposit, with durable state, does not.
    expect(deposit.match(/if \(!live\(\)\) throw new Error\(`This deposit was superseded[^`]*`\);\n\s*\}\)/g)?.length).toBe(1);
    expect(deposit).toContain('}, DEPOSIT_GAS_BUDGET);\n');
  });

  test('the leg guard: closed before leg 1 aborts, closed between legs still sends leg 2', async () => {
    // Mirrors sendRegistrationLeg's guard.
    const run = async (closedAt: 'none' | 'leg1' | 'leg2') => {
      let legSent = false;
      let open = true;
      const sent: string[] = [];
      const leg = async (name: string) => {
        if (closedAt === name) open = false; // closed during the fee lookup
        if (!legSent && !open) throw new Error('closed');
        legSent = true;
        sent.push(name);
      };
      try { await leg('leg1'); await leg('leg2'); } catch { /* aborted */ }
      return sent;
    };
    expect(await run('leg1')).toEqual([]);
    expect(await run('leg2')).toEqual(['leg1', 'leg2']);
    expect(await run('none')).toEqual(['leg1', 'leg2']);
  });

  test('the tip floor is Ethereum only, in the send AND in every gasPrice-only bound', () => {
    expect(walletTxCostWei({ gasUnits: 51_000n, gasPriceWei: 10_000_000n, chainId: 10 })).toBe(61_200n * 20_000_000n);
    expect(walletTxCostWei({ gasUnits: 51_000n, gasPriceWei: 10_000_000n, chainId: 1 })).toBe(61_200n * 120_000_000n);
    // The L2 case from review: a wallet holding 5e12 wei can self-register.
    expect(decideViewingKeyPath({ balanceWei: 5_000_000_000_000n, gasPriceWei: 10_000_000n, gasEstimate: 51_000n, chainId: 10 }).path)
      .toBe('self-register');
    expect(viewingKeyShortfallWei({ gasPriceWei: 10_000_000n, balanceWei: 0n, gasEstimate: 51_000n, chainId: 10 })).toBe(61_200n * 20_000_000n);
  });
});
