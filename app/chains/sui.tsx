import { PoolPageContent } from '@/components/pools/pool-page-content';

// Clean single-segment route for the SUI pool (/chains/sui) — the app is
// multi-chain, so the Sui pool shouldn't be nested under an EVM chain name.
// The asset-driven [chainName]/[poolAssetName] route still resolves any old
// /chains/<chain>/sui deep links.
export default function SuiPoolPage() {
  return <PoolPageContent forcedPoolAsset="sui" />;
}
