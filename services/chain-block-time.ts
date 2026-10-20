/**
 * Block time per EVM chain, in milliseconds.
 *
 * Used as the reuse window for the chain head: asking `eth_blockNumber` more
 * than once per block cannot return anything new, it only adds requests. Pure
 * module (no config imports) so bun tests can load it.
 */

/** For a chain not in the table. Short on purpose: too short costs requests, too long costs freshness. */
export const DEFAULT_BLOCK_TIME_MS = 2_000;

const BLOCK_TIME_MS: Readonly<Record<number, number>> = {
  1: 12_000, // Ethereum
  11155111: 12_000, // Sepolia
  10: 2_000, // OP Mainnet
  11155420: 2_000, // OP Sepolia
  8453: 2_000, // Base
  84532: 2_000, // Base Sepolia
  56: 750, // BNB Chain (Maxwell)
  42161: 250, // Arbitrum One
  4663: 100, // Robinhood Chain (100k blocks in ~10,060 s, measured 2026-10-14)
  4114: 2_000, // Citrea
  5115: 2_000, // Citrea testnet
};

export function blockTimeMs(chainId: number): number {
  return BLOCK_TIME_MS[chainId] ?? DEFAULT_BLOCK_TIME_MS;
}

/** Per-chain map for wagmi's `createConfig`, which accepts `{ [chainId]: value }`. */
export function blockTimeByChain(chainIds: readonly number[]): Record<number, number> {
  return Object.fromEntries(chainIds.map((id) => [id, blockTimeMs(id)]));
}
