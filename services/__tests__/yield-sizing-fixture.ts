import { PoolSessionYieldDeposit, ZAP_SUPPLY_BUFFER_UNITS } from '@privacy-pools-v2/sdk';

// DEV-489 QA (BNB Chain, pay with BNB into ppUSDT). The refusal is produced by
// the vendored SDK's own sizeSharesForBudget, fed with reads taken from BNB
// mainnet: vault 0x6C17bE9c864254CA4b2d36223f31AdE94B4d64c2, router
// 0x9929Ad2Edc2E0B5D59C3f5b2910812D0c8b84E16, budget 16.2026 USDT.
//   previewDeposit(principal) @125897542 = 16171136970815352673
//   previewDeposit(principal) @125897546 = 16171136958181100995
//   quote(each) @125897546 -> 16202583810058820592 / 16202583797400000000
// At one block the quote equals spendNow exactly (16202583797400000000), so a
// 4-block gap between the two RPC reads is enough to refuse.

export const BUDGET = 16_202_600_000_000_000_000n;
export const PRINCIPAL = 16_202_583_797_399_999_998n;
export const QUOTES: Record<string, bigint> = {
  '16171136970815352673': 16_202_583_810_058_820_592n,
  '16171136958181100995': 16_202_583_797_400_000_000n,
};

export function sizer(previewAt: bigint[]) {
  let call = 0;
  return new PoolSessionYieldDeposit({
    deployment: {},
    deposit: {},
    allowanceOf: async () => 0n,
    yieldToken: {
      previewDeposit: async (amount: bigint) => {
        if (amount !== PRINCIPAL) throw new Error(`unexpected principal ${amount}`);
        return previewAt[Math.min(call++, previewAt.length - 1)];
      },
    },
    router: {
      // The real router interactor returns the zap's constant without a request.
      supplyBufferUnits: async () => ZAP_SUPPLY_BUFFER_UNITS,
      quote: async (shares: bigint) => ({ underlyingNeeded: QUOTES[shares.toString()], total: shares }),
    },
  } as never);
}

export async function sdkYieldSizingRefusal(): Promise<unknown> {
  try {
    await sizer([16_171_136_970_815_352_673n]).sizeSharesForBudget(BUDGET);
  } catch (err) {
    return err;
  }
  throw new Error('expected the SDK to refuse');
}
