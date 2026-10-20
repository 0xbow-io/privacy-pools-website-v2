/**
 * Chain router hook — routes operations to the correct chain implementation.
 *
 * Provides chain-aware functions that delegate to either EVM (wagmi) or
 * Sui (dapp-kit) based on the currently selected chain.
 *
 * Usage in modals:
 *   const { activeChain, isSui } = useChainRouter();
 *   if (isSui) {
 *     // Use Sui transaction builders
 *   } else {
 *     // Use existing wagmi flow
 *   }
 */
import { useState, useCallback, useMemo } from 'react';
import {
  type ChainConfig,
  type ChainType,
  getChainConfig,
  supportedChainIds,
  defaultChainId,
} from '@/config/chains';
import { useChainContext } from '@/components/chain-provider';

interface ChainRouter {
  /** Currently selected chain config */
  activeChain: ChainConfig | undefined;
  /** Currently selected chain ID */
  activeChainId: number;
  /** Whether active chain is Sui */
  isSui: boolean;
  /** Whether active chain is Stellar */
  isStellar: boolean;
  /** Whether active chain is EVM */
  isEvm: boolean;
  /** Active chain type */
  chainType: ChainType;
  /** Switch the selected chain */
  selectChain: (chainId: number) => Promise<import('@/components/chain-provider').ChainSelectOutcome>;
  /** All supported chains */
  supportedChains: ChainConfig[];
  /** Explorer URL for a transaction */
  getExplorerUrl: (txHash: string) => string;
}

export function useChainRouter(): ChainRouter {
  const chainContext = useChainContext();

  // Prefer the app-wide shared selection (ChainProvider). Fall back to local
  // state when no provider is mounted so standalone usage still works.
  const [localChainId, setLocalChainId] = useState(defaultChainId);
  const selectedChainId = chainContext?.selectedChainId ?? localChainId;
  const setSelectedChainId = chainContext?.selectChain
    ?? (async (chainId: number) => { setLocalChainId(chainId); return 'committed' as const; });

  const activeChain = useMemo(() => getChainConfig(selectedChainId), [selectedChainId]);
  const isSui = activeChain?.chainType === 'sui';
  const isStellar = activeChain?.chainType === 'stellar';
  const isEvm = activeChain?.chainType === 'evm';

  const supportedChains = useMemo(
    () => supportedChainIds
      .map(id => getChainConfig(id))
      .filter((c): c is ChainConfig => c !== undefined),
    []
  );

  const getExplorerUrl = useCallback((txHash: string) => {
    if (!activeChain) return '';
    if (isSui) {
      return `${activeChain.explorerUrl}/txblock/${txHash}`;
    }
    if (isStellar) {
      return `${activeChain.explorerUrl}/tx/${txHash.replace(/^0x/, '')}`;
    }
    return `${activeChain.explorerUrl}/tx/${txHash}`;
  }, [activeChain, isSui, isStellar]);

  return {
    activeChain,
    activeChainId: selectedChainId,
    isSui,
    isStellar,
    isEvm,
    chainType: activeChain?.chainType ?? 'evm',
    selectChain: setSelectedChainId,
    supportedChains,
    getExplorerUrl,
  };
}
