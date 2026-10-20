/**
 * Multi-chain wallet hook — abstracts over EVM (wagmi) and Sui (dapp-kit).
 *
 * Provides a unified interface for:
 * - Checking connection status
 * - Getting connected address
 * - Identifying the active chain type
 *
 * The ACTIVE CHAIN SELECTION (ChainProvider) decides which wallet this hook
 * reports — not "whichever wallet happens to be connected". With both an EVM
 * and a Sui wallet connected, an active EVM chain returns the wagmi account
 * and an active Sui chain returns the dapp-kit account, so display and
 * transaction routing can never disagree with the selected chain.
 * (ChainProvider auto-selects Sui on Sui-wallet connect, so the common
 * single-wallet flows still resolve to the connected wallet.)
 */
import { useAccount as useEvmAccount, useChainId as useEvmChainId } from 'wagmi';
import { useCurrentAccount as useSuiAccount } from '@mysten/dapp-kit';
import { useChainContext } from '@/components/chain-provider';
import { useStellarWallet } from '@/components/stellar-wallet-provider';
import {
  type ChainType,
  defaultChainId,
  getChainConfig,
  suiAccountSupportsApp,
} from '@/config/chains';
import { NATIVE_MOCK_ACTIVE } from '@/constants/native-mock';
import { getNativeMockWallet } from '@/services/native-mock-data';

export interface MultiChainWallet {
  /** Whether any wallet is connected */
  isConnected: boolean;
  /** The connected address (EVM hex or Sui base58) */
  address: string | undefined;
  /** Which chain type is active */
  chainType: ChainType | undefined;
  /** The active chain ID */
  chainId: number | undefined;
  /** Whether this is a Sui connection */
  isSui: boolean;
  isStellar: boolean;
  /** Whether this is an EVM connection */
  isEvm: boolean;
  /**
   * Sui only: true when the connected wallet's network has no configured
   * deployment (e.g. the wallet is on mainnet while the app is testnet-only).
   * The UI should warn + block flows rather than build a tx for the wrong net.
   */
  networkMismatch: boolean;
}

export function useMultiChainWallet(): MultiChainWallet {
  const wallet = useRealMultiChainWallet();
  // Native mock mode: the mock account reads as a connected EVM wallet.
  // NATIVE_MOCK_ACTIVE is a build constant, so the hook order never changes.
  // The mock is an EVM account, so a Sui session keeps its real wallet.
  return NATIVE_MOCK_ACTIVE && !wallet.isSui ? (getNativeMockWallet() ?? wallet) : wallet;
}

function useRealMultiChainWallet(): MultiChainWallet {
  // EVM wallet state
  const evmAccount = useEvmAccount();
  const evmChainId = useEvmChainId();

  // Sui wallet state
  const suiAccount = useSuiAccount();

  // The app-wide chain selection is the routing truth.
  const chainContext = useChainContext();
  const selectedChainId = chainContext?.selectedChainId ?? defaultChainId;
  const activeIsSui = getChainConfig(selectedChainId)?.chainType === 'sui';
  const activeIsStellar = getChainConfig(selectedChainId)?.chainType === 'stellar';

  // Stellar wallet state (Freighter)
  const stellarWallet = useStellarWallet();

  if (activeIsSui) {
    if (suiAccount) {
      return {
        isConnected: true,
        address: suiAccount.address,
        chainType: 'sui',
        chainId: selectedChainId,
        isSui: true,
        isStellar: false,
        isEvm: false,
        // `chains` is the account's supported-chain capability list. Flag (fail
        // closed) when it can't sign for the app's enabled Sui network; the Sui
        // session's submit guard enforces it before any on-chain submit.
        networkMismatch: !suiAccountSupportsApp(suiAccount.chains),
      };
    }
    // Sui chain selected but no Sui wallet connected: report disconnected (the
    // header's Connect Wallet then routes to the Sui Wallet Standard).
    return {
      isConnected: false,
      address: undefined,
      chainType: 'sui',
      chainId: selectedChainId,
      isSui: true,
      isStellar: false,
      isEvm: false,
      networkMismatch: false,
    };
  }

  if (activeIsStellar) {
    const connected = stellarWallet.isConnected && !!stellarWallet.address;
    return {
      isConnected: connected,
      address: connected ? stellarWallet.address ?? undefined : undefined,
      chainType: 'stellar',
      chainId: selectedChainId,
      isSui: false,
      isStellar: true,
      isEvm: false,
      // Freighter on another network (Mainnet/Futurenet): the SDK's own
      // interactor also refuses to sign, this lets the UI say so first.
      networkMismatch: connected && stellarWallet.networkMismatch,
    };
  }

  if (evmAccount.isConnected) {
    // The wallet's ACTUAL chain: connector-first (useAccount().chainId is the
    // only source that reports a foreign network), store fallback while the
    // connector is still resolving. Reporting the store here made the
    // chain-selector's "connected" badge claim a configured chain while the
    // wallet sat on an unsupported one.
    const walletChainId = evmAccount.chainId ?? evmChainId;
    const chainConfig = getChainConfig(walletChainId);
    return {
      isConnected: true,
      address: evmAccount.address,
      chainType: chainConfig?.chainType ?? 'evm',
      chainId: walletChainId,
      isSui: false,
      isStellar: false,
      isEvm: true,
      networkMismatch: false,
    };
  }

  return {
    isConnected: false,
    address: undefined,
    chainType: undefined,
    chainId: undefined,
    isSui: false,
    isStellar: false,
    isEvm: false,
    networkMismatch: false,
  };
}
