import { getConfiguredNativeYieldDeployment } from '@/config/yield';
import { getTokenMetadata } from '@/config/tokens';
import { requestWalletRefusal } from '@/services/request-wallet-rule';

/**
 * Why this request cannot be paid from a wallet, or null when it can (DEV-422).
 * The ONE decision behind both the "Pay via Wallet" buttons and the handler, so
 * the button can never look live for a request the handler refuses.
 */
export function requestWalletRefusalFor(request: { tokenId: string; chainId: number }): string | null {
  return requestWalletRefusal(
    getTokenMetadata(request.tokenId, request.chainId),
    !!getConfiguredNativeYieldDeployment(request.chainId),
  );
}
