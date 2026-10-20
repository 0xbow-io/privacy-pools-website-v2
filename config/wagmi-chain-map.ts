// The viem Chain object for every id this app can register — PURE module
// (no react-native imports) shared by all three wagmi configs and
// bun-testable (services/__tests__/wagmi-chain-map.test.ts).
//
// INVARIANT: every id chains.ts can put into `supportedEvmChainIds` (the
// build's base chain + every STAGING_CHAINS entry + every ALL_PROD_CHAINS
// entry) MUST have an entry here. An unmapped id is silently dropped from
// wagmi's chain list, which makes the chain selectable in the UI but
// unswitchable: switchChainAsync throws ChainNotConfiguredError,
// chain-provider's catch swallows it, and the click is a no-op. That is exactly
// how OP shipped broken in 596eba2 — the selector listed Optimism but wagmi had
// never heard of chain 10.
import { sepolia, mainnet, citrea, optimism, bsc, base, arbitrum } from 'wagmi/chains';
import { defineChain, type Chain } from 'viem';

/**
 * Robinhood Chain mainnet (an Arbitrum Orbit chain). The viem version this app
 * pins does not ship it, so it is defined here. Id 4663 per chainid.network and
 * eth_chainId on the chain's own RPC (46630 is the testnet). Multicall3 has
 * code at the canonical address there (checked 2026-10-14).
 */
export const robinhoodChain: Chain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
});

export const VIEM_CHAIN_BY_ID: Record<number, Chain> = {
  [sepolia.id]: sepolia,
  [mainnet.id]: mainnet,
  [citrea.id]: citrea,
  [optimism.id]: optimism,
  [bsc.id]: bsc,
  [base.id]: base,
  [arbitrum.id]: arbitrum,
  [robinhoodChain.id]: robinhoodChain,
};
