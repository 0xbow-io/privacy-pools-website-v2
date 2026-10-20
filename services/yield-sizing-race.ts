/**
 * The SDK's share sizing for a yield pool (`sizeSharesForBudget`) reads the
 * vault's `previewDeposit` and the router's `quote` as two separate RPC calls.
 * At one block the quote equals the spendable budget to the wei, so there is no
 * margin at all: a block of rate accrual between the two reads (BNB Chain
 * ppUSDT, DEV-489 QA) puts the quote a few hundred-millionths over and the SDK
 * refuses with "size again". Nothing was quoted or signed yet, so do what it
 * says, a bounded number of times, with the same budget.
 */
export function isYieldSizingRace(err: unknown): boolean {
  if (!(err instanceof Error) || err.name !== 'InvalidYieldAmount') return false;
  const code = (err as Error & { amounts?: { code?: unknown } }).amounts?.code;
  return code === 'invalidYieldAmount' && /exceeds the spendable budget/.test(err.message);
}

export const YIELD_SIZING_ATTEMPTS = 3;

export async function prepareSizedAgain<T>(prepare: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await prepare();
    } catch (err) {
      if (attempt >= YIELD_SIZING_ATTEMPTS || !isYieldSizingRace(err)) throw err;
      console.log('[SwapDeposit] vault rate moved while sizing, sizing again', attempt);
    }
  }
}
