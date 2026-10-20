import { getSupportedChains } from '@/config/chains';
import { embeddedConnector } from '@/services/embedded-wallet';

// Builds the embedded smart-wallet's wagmi connector with an RPC URL per
// supported chain (it signs + broadcasts the EOA's transactions locally). Wired
// into the web/native wagmi configs only when smartWalletActive() — so existing
// ppv2 flows (deposit, secret derivation) work through it with no popups when
// the smart wallet is on, and are untouched when it's off.
export function makeEmbeddedConnector() {
  const rpcUrls: Record<number, string> = {};
  for (const chain of getSupportedChains()) {
    rpcUrls[chain.id] = chain.rpcUrl;
  }
  return embeddedConnector({ rpcUrls });
}
