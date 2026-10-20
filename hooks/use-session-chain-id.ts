import { useAccount, useChainId } from 'wagmi';
import { getChainConfig, isSupportedEvmChainId } from '@/config/chains';
import { useChainContext } from '@/components/chain-provider';
import { useWalletChainExcursionHome } from '@/hooks/use-wallet-chain-excursion';

/**
 * The chain the SESSION binds to — the single authority shared by
 * SdkProvider (which creates the session) and every consumer of the
 * session's per-chain storage (stored account exports, note counts,
 * export/import, the disconnect warning).
 *
 * Authority order, copied verbatim from SdkProvider's derivation:
 *   1. the connected wallet's actual chain (writes execute there),
 *   2. the app's selected EVM chain (the UI truth for key/passkey sessions
 *      with no wallet),
 *   3. wagmi's config-store value (on single-EVM mainline all three agree).
 *
 * Except during a wallet excursion (services/wallet-chain-excursion.ts): the
 * wallet is on another chain for one transaction and the session stays home.
 *
 * Why not raw useChainId(): that is the wagmi CONFIG STORE chain. With
 * syncConnectedChain (wagmi's default, not overridden here) the store DOES
 * follow the connector — but only across CONFIGURED chains — and it can
 * diverge from the session's chain two ways: it boots/persists on a chain
 * the user isn't acting on (first configured chain on a fresh staging
 * profile), and it holds its last configured value while the wallet sits on
 * a foreign network. Consumers keyed on it read a DIFFERENT chain's storage
 * bucket than the session actually writes: use-notes surfaced zero notes,
 * Export downloaded the wrong chain's backup, and the disconnect warning
 * counted the wrong chain's notes.
 */
export function useSessionChainId(): number {
  const { isConnected, chainId: connectorChainId } = useAccount();
  const wagmiStoreChainId = useChainId();
  const chainSelection = useChainContext();
  const excursionHome = useWalletChainExcursionHome();
  const selectedEvmChainId =
    chainSelection && getChainConfig(chainSelection.selectedChainId)?.chainType === 'evm'
      ? chainSelection.selectedChainId
      : undefined;
  if (excursionHome !== null) return excursionHome;
  return isConnected && connectorChainId !== undefined && isSupportedEvmChainId(connectorChainId)
    ? connectorChainId
    : (selectedEvmChainId ?? wagmiStoreChainId);
}
