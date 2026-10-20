import { PoolPageContent } from '@/components/pools/pool-page-content';

// Clean single-segment route for the Stellar testnet XLM pool (/chains/stellar),
// the same shape as /chains/sui: a non-EVM pool isn't nested under an EVM chain.
export default function StellarPoolPage() {
  return <PoolPageContent forcedPoolAsset="xlm" />;
}
