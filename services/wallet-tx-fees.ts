// One fee policy for every wallet-signed transaction (DEV-542, after DEV-554).
//
// Left to itself a wallet prices a tx from its own fee tiers. On Ethereum at a
// ~0.1 gwei base fee its default tip alone was ~10x the whole fee, so the
// prompt showed ~$5 for a deposit that paid $0.28, and ~$1.36 to register.
// So the app sets the numbers itself, from its own public RPC:
//
//   gas:       the node's estimate + 20% (a per-kind budget when it cannot estimate)
//   EIP-1559:  tip = max(eth_maxPriorityFeePerGas, chain floor), maxFee = 2 x base fee + tip
//   legacy:    gasPrice = eth_gasPrice as is (a block without a base fee)
//   unknown:   block unread -> no fee fields, the wallet prices it
//   BNB Chain: no fee fields, the wallet prices it (DEV-589, WALLET_PRICED_CHAINS)
//
// `costWei` = gas x maxFee (legacy: gas x gasPrice) is what the wallet reserves
// and is the one figure any in-app estimate or pre-check shows.
//
// Privacy: eth_gasPrice / latest block / eth_maxPriorityFeePerGas take no
// user input. eth_estimateGas carries the same {from,to,data,value} the caller
// already simulates with eth_call on the same RPC and then broadcasts.
import type { Address, Hex } from 'viem';

export const WALLET_GAS_HEADROOM_BPS = 2_000n;
export const WALLET_FEE_HEADROOM_BPS = 5_000n;

/**
 * Fallback gas when the node cannot estimate. Deposit: a real ETH deposit used
 * 963,277 (0x6e3876b3...) and the budget + 20% must still cover it.
 */
export const DEPOSIT_GAS_BUDGET = 1_000_000n;

export type WalletTxFees =
  | { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
  | { gasPrice: bigint };

export interface WalletTxPlan {
  /** Undefined when there was neither an estimate nor a budget: the wallet estimates. */
  gas: bigint | undefined;
  fees: WalletTxFees | null;
  /** gas x max fee per gas, or null when the gas limit is unknown. */
  costWei: bigint | null;
}

export function walletGasLimit(gas: bigint): bigint {
  return (gas * (10_000n + WALLET_GAS_HEADROOM_BPS)) / 10_000n;
}

/**
 * Tip floor per chain. QA 2026-10-14 (MetaMask, Ethereum, after DEV-554):
 * a tx sent with the node's ~0.01 gwei tip and maxFee 1.5 x gasPrice was
 * flagged by MetaMask with Confirm greyed out until "slow" was picked. The
 * floor keeps the tip at a level wallets accept by default on Ethereum while
 * the fee stays far below MetaMask's ~2 gwei "market" tip. Other chains: the
 * node's suggestion as is (their fees are orders of magnitude smaller).
 */
export const MIN_PRIORITY_FEE_WEI: Readonly<Record<number, bigint>> = { 1: 100_000_000n };

export function minPriorityFeeFor(chainId: number | null | undefined): bigint {
  return (chainId != null ? MIN_PRIORITY_FEE_WEI[chainId] : undefined) ?? 0n;
}

/**
 * Upper bound of the max fee per gas a tx is sent with, from eth_gasPrice
 * alone (gasPrice ~ base + node tip, so 2 x base + max(tip, floor) is at most
 * 2 x gasPrice + floor). Used where only gasPrice is known: affordability
 * pre-checks, top-up sizing and the native gas reserve.
 */
export function walletMaxFeePerGas(gasPriceWei: bigint, chainId?: number | null): bigint {
  return 2n * gasPriceWei + minPriorityFeeFor(chainId);
}

/** Upper bound of what the wallet reserves for `gasUnits` (before headroom) at `gasPriceWei`. */
export function walletTxCostWei(input: { gasUnits: bigint; gasPriceWei: bigint; chainId?: number | null }): bigint {
  return walletGasLimit(input.gasUnits) * walletMaxFeePerGas(input.gasPriceWei, input.chainId);
}

/**
 * A registration leg may only be sent while the connected wallet is still the
 * run's owner on the run's chain (the calldata is that owner's).
 */
export function registrationOwnerUnchanged(input: {
  owner: string | null | undefined;
  chainId: number;
  current: { address?: string | null; chainId?: number | null };
}): boolean {
  if (!input.owner || !input.current.address) return false;
  return input.current.address.toLowerCase() === input.owner.toLowerCase() && input.current.chainId === input.chainId;
}

/** Gas units a cross-pay shield (swap then deposit, flow-1 route) is reserved for. */
export const CROSS_PAY_SHIELD_GAS_UNITS = 2_500_000n;

/** Fallback gas price while eth_gasPrice is unread. */
export const UNREAD_GAS_PRICE_WEI = 3_000_000_000n;

export const NATIVE_GAS_RESERVE_PCT = 160n;

/**
 * Native gas held back from a Max shield: 1.6x the bound of the FALLBACK plan
 * (budget gas + 20%, x maxFee). 1.6 = 1.125^4, four full blocks of base-fee
 * rise between this read and the wallet's own value + gas x maxFee check,
 * even when the node cannot estimate and the budget is sent. Still well
 * under the old 2x-on-top reserve. ONE helper for the Shield tab's Max and
 * the deposit check (DEV-542).
 */
export function nativeDepositGasReserveWei(input: {
  gasPriceWei: bigint | null | undefined;
  chainId?: number | null;
  crossPay?: boolean;
}): bigint {
  const gasUnits = input.crossPay ? CROSS_PAY_SHIELD_GAS_UNITS : DEPOSIT_GAS_BUDGET;
  const bound = walletTxCostWei({ gasUnits, gasPriceWei: input.gasPriceWei ?? UNREAD_GAS_PRICE_WEI, chainId: input.chainId });
  return (bound * NATIVE_GAS_RESERVE_PCT) / 100n;
}

/**
 * The most a wallet can shield: balance minus the native gas reserve (native
 * pay token only), then net of the vetting fee charged on top (same-token
 * only; cross-pay takes it from the converted amount).
 */
export function maxShieldAmountWei(input: {
  balanceWei: bigint;
  payIsNative: boolean;
  gasPriceWei: bigint | null | undefined;
  chainId?: number | null;
  crossPay?: boolean;
  vettingFeeBps?: number | null;
}): bigint {
  let max = input.balanceWei;
  if (input.payIsNative) {
    const reserve = nativeDepositGasReserveWei(input);
    max = max > reserve ? max - reserve : 0n;
  }
  if (!input.crossPay && input.vettingFeeBps != null && input.vettingFeeBps > 0) {
    // amount + floor(amount·f/10000) <= balance for amount = floor(balance·10000/(10000+f)).
    max = (max * 10_000n) / (10_000n + BigInt(input.vettingFeeBps));
  }
  return max;
}

/**
 * EIP-1559: tip = max(node suggestion, chain floor); maxFee = 2 x base fee +
 * tip, the same shape wallets and viem use, so a wallet does not flag it.
 * Without a base fee reading the gasPrice bound is used.
 */
export function planWalletTx(input: {
  gasEstimate?: bigint | null;
  fallbackGas?: bigint | null;
  eip1559: boolean | null;
  priorityFeeWei?: bigint | null;
  baseFeeWei?: bigint | null;
  minPriorityFeeWei?: bigint | null;
  gasPriceWei: bigint;
}): WalletTxPlan {
  const units = input.gasEstimate && input.gasEstimate > 0n
    ? input.gasEstimate
    : input.fallbackGas && input.fallbackGas > 0n ? input.fallbackGas : null;
  const gas = units === null ? undefined : walletGasLimit(units);
  const costAt = (perGas: bigint) => (gas === undefined ? null : gas * perGas);
  if (input.eip1559 === null) return { gas, fees: null, costWei: costAt(2n * input.gasPriceWei + (input.minPriorityFeeWei ?? 0n)) };
  if (!input.eip1559) return { gas, fees: { gasPrice: input.gasPriceWei }, costWei: costAt(input.gasPriceWei) };
  const suggested = input.priorityFeeWei != null && input.priorityFeeWei >= 0n ? input.priorityFeeWei : 0n;
  const floor = input.minPriorityFeeWei ?? 0n;
  const maxPriorityFeePerGas = suggested > floor ? suggested : floor;
  const maxFeePerGas = input.baseFeeWei != null
    ? 2n * input.baseFeeWei + maxPriorityFeePerGas
    : 2n * input.gasPriceWei + maxPriorityFeePerGas;
  return { gas, fees: { maxFeePerGas, maxPriorityFeePerGas }, costWei: costAt(maxFeePerGas) };
}

/** The fields to spread into a wagmi `sendTransaction` call. */
export function walletTxFields(plan: WalletTxPlan | null): Partial<{ gas: bigint } & WalletTxFees> {
  if (!plan) return {};
  return { ...(plan.gas !== undefined ? { gas: plan.gas } : {}), ...(plan.fees ?? {}) };
}

/** The subset of a viem public client the reads need. */
export interface FeeReadClient {
  getGasPrice: () => Promise<bigint>;
  getBlock: (args: { blockTag: 'latest' }) => Promise<{ baseFeePerGas?: bigint | null }>;
  estimateMaxPriorityFeePerGas: () => Promise<bigint>;
  estimateGas: (args: { account: Address; to: Address; data?: Hex; value?: bigint }) => Promise<bigint>;
}

export interface FeeMarket {
  gasPriceWei: bigint;
  eip1559: boolean | null;
  priorityFeeWei: bigint | null;
  baseFeeWei: bigint | null;
}

/**
 * Chains whose wallet txs carry NO fee fields: the wallet prices them, as it
 * did before DEV-542 (DEV-589).
 *
 * BNB Chain blocks carry `baseFeePerGas: 0`, so wallets disagree on what the
 * chain is (MetaMask turns a dapp `gasPrice` into a type-2 tx, others sign it
 * legacy) and each broadcasts through its own node, whose minimum gas price
 * need not be the app RPC's `eth_gasPrice` (0.05 gwei). The forced `gasPrice`
 * was the one BNB-only field DEV-542 added, and registering from a mobile
 * wallet failed on BNB only after it shipped. The fee there is a fraction of a
 * cent, so the wallet's own tier costs nothing that matters. The gas limit is
 * still set, as on every other chain, and `costWei` is bounded at 2 x gasPrice
 * so the pre-checks and the top-up sizing keep their headroom.
 */
export const WALLET_PRICED_CHAINS: ReadonlySet<number> = new Set([56, 97]);

/**
 * Whether the wallet's native balance covers a planned tx, for the pre-send
 * gas check. A plan with no fee fields means one of two things:
 *  - the block could not be read: nothing reliable to check, the wallet decides;
 *  - a WALLET_PRICED_CHAINS chain (BNB): the wallet sets the fee, but `costWei`
 *    is still a real bound (gas x 2 x gasPrice), so the check stays ON there.
 *    Treating BNB like "unread" switched off the "not enough BNB for gas"
 *    check (review of DEV-589).
 */
export function walletTxAffordable(input: {
  plan: Pick<WalletTxPlan, 'fees' | 'costWei'>;
  balanceWei: bigint;
  chainId?: number | null;
}): boolean {
  const { plan, balanceWei, chainId } = input;
  if (plan.costWei === null) return true;
  const walletPriced = chainId != null && WALLET_PRICED_CHAINS.has(chainId);
  if (plan.fees === null && !walletPriced) return true;
  return balanceWei >= plan.costWei;
}

/** eth_gasPrice + latest block (one retry) + tip suggestion. */
export async function readFeeMarket(client: FeeReadClient, chainId?: number | null): Promise<FeeMarket> {
  if (chainId != null && WALLET_PRICED_CHAINS.has(chainId)) {
    // `eip1559: null` is the "no fee fields, the wallet prices it" plan. The
    // gas price is still read: it bounds `costWei` for the in-app checks.
    return { gasPriceWei: await client.getGasPrice(), eip1559: null, priorityFeeWei: null, baseFeeWei: null };
  }
  const [gasPriceWei, block] = await Promise.all([
    client.getGasPrice(),
    // A block still unread means "unknown", never "legacy".
    client.getBlock({ blockTag: 'latest' })
      .catch(() => client.getBlock({ blockTag: 'latest' }))
      .catch(() => null),
  ]);
  const baseFeeWei = block?.baseFeePerGas ?? null;
  const eip1559 = block === null ? null : baseFeeWei !== null;
  let priorityFeeWei: bigint | null = null;
  if (eip1559 && baseFeeWei !== null) {
    priorityFeeWei = await client.estimateMaxPriorityFeePerGas().catch(() => null);
    // No tip suggestion: the legacy price minus the base fee is the node's tip.
    if (priorityFeeWei === null) priorityFeeWei = gasPriceWei > baseFeeWei ? gasPriceWei - baseFeeWei : 0n;
  }
  return { gasPriceWei, eip1559, priorityFeeWei, baseFeeWei };
}

/**
 * Price one wallet tx. Never throws: on a failed fee read it returns null and
 * the tx goes out as before, priced by the wallet.
 */
export async function priceWalletTx(
  client: FeeReadClient | null | undefined,
  tx: { account: Address; to: Address; data?: Hex; value?: bigint },
  fallbackGas?: bigint | null,
  chainId?: number | null,
): Promise<WalletTxPlan | null> {
  if (!client) return null;
  try {
    const market = await readFeeMarket(client, chainId);
    const gasEstimate = await client.estimateGas(tx).catch(() => null);
    return planWalletTx({ ...market, gasEstimate, fallbackGas, minPriorityFeeWei: minPriorityFeeFor(chainId) });
  } catch {
    return null;
  }
}
