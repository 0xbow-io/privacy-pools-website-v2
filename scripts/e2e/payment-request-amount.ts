import { formatEther, parseEther } from 'viem';

/** Keep price headroom when possible, without exceeding the approved fixture cap. */
export function paymentRequestAmount({ price, minimumUsd, noteWei, reserveWei }: {
  price: number; minimumUsd: number; noteWei: bigint; reserveWei: bigint;
}): string {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(minimumUsd) || minimumUsd <= 0) {
    throw new Error('payment request amount: invalid USD price or request floor');
  }
  const step = 10n ** 13n; // 0.00001 ETH
  const ceilStep = (value: bigint) => ((value + step - 1n) / step) * step;
  const preferred = ceilStep(parseEther((minimumUsd * 1.25 / price).toFixed(18)));
  const minimum = ceilStep(parseEther((minimumUsd * 1.10 / price).toFixed(18)));
  const budget = ((noteWei - reserveWei) / step) * step;
  if (budget < minimum) {
    throw new Error('payment request amount: fixture cap cannot cover the request floor with 10% price headroom plus the fee reserve; refusing to spend');
  }
  return formatEther(preferred < budget ? preferred : budget);
}
