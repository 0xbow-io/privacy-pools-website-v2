import { getDefaultChainConfig, type ChainConfig } from '@/config/chains';
import { useChainRouter } from '@/hooks/use-chain-router';

/**
 * The EVM chain that chain-scoped data surfaces should describe.
 *
 * Mainline builds carry ONE EVM chain, so this is always the build default
 * there. The staging build (EXPO_PUBLIC_STAGING=true) serves two EVM chains
 * behind the header selector — mainnet and Citrea — and every per-chain query
 * (assets-stats, statistics, pool lists, payroll history) must follow the
 * selection instead of pinning the default, or switching chains would change
 * the header while every number stayed on mainnet.
 *
 * When the selection is a NON-EVM chain (Sui), EVM surfaces keep the default
 * EVM chain — same behaviour those surfaces had before this hook existed.
 */
export function useActiveEvmChain(): ChainConfig {
  const { activeChain } = useChainRouter();
  if (activeChain?.chainType === 'evm') return activeChain;
  return getDefaultChainConfig();
}
