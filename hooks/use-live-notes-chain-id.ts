import { STELLAR_TESTNET_ID, SUI_TESTNET_ID } from '@/config/chains';
import { useSdkContext } from '@/components/sdk-provider';
import { useChainRouter } from '@/hooks/use-chain-router';
import { useSessionChainId } from '@/hooks/use-session-chain-id';

/**
 * The chain the live notes (`useNotes`) belong to: the selected Sui or Stellar
 * session's, else the EVM session chain. Null mid EVM switch, while the live
 * manager is still the previous chain's and the selection already names the
 * next: the live notes are then nobody's to key, and each chain reads its
 * stored copy until the session follows.
 */
export function useLiveNotesChainId(): number | null {
  const { isSui, isStellar } = useChainRouter();
  const evmSessionChainId = useSessionChainId();
  const { sessionTarget } = useSdkContext();
  if (isSui) return SUI_TESTNET_ID;
  if (isStellar) return STELLAR_TESTNET_ID;
  return !sessionTarget || sessionTarget.chainId === evmSessionChainId ? evmSessionChainId : null;
}
