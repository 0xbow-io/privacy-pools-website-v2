import { useShareYield } from '@/hooks/use-share-yield';
import { formatApyPercent } from '@/services/share-yield';
import { YieldPositionHint } from '@/components/yield/yield-position-hint';
import { Pill, PILL_ICON_SIZE } from '@/components/ui/pill';

/**
 * Pill with the live NET APY of a yield-bearing pool share (ppUSDC / ppUSDT),
 * read on chain. Renders nothing for a plain asset, while loading, or when the
 * reads fail: no placeholder, no demo figure. The number is NET (after the
 * wrapper's fee). It reads just "APY" with no venue (Mike, 2026-09-18:
 * "1.17% net APY · Aave v3" became "1.17% APY"; the net-ness and the venue
 * live in the pool page's yield card, where there is room to explain them).
 */
export function ShareApyChip({ chainId, tokenAddress, testID }: { chainId: number | undefined; tokenAddress: string | undefined; testID?: string }) {
  const { yield: live } = useShareYield({ chainId, tokenAddress });
  if (!live) return null;
  return (
    <Pill
      tone="success"
      label={`${formatApyPercent(live.netApyPercent)}% APY`}
      trailing={<YieldPositionHint size={PILL_ICON_SIZE} />}
      testID={testID ?? 'share-apy-chip'}
    />
  );
}
