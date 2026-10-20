// The user's REAL wallet holdings for the shield widget's pay-token picker,
// via Alchemy's Portfolio API (getTokensByAddress). Env-gated on
// EXPO_PUBLIC_ALCHEMY_KEY and per-network support — chains Alchemy doesn't
// serve (Citrea) or keyless builds get nothing, and the picker falls back to
// the chain's configured pool assets.
//
// Client-side by design for this build: the key ships in the bundle either
// way (it already backs RPC URLs), bounded by Alchemy's per-key domain
// allowlist. Every chain this build serves is asked for in one request, so
// the request says nothing about which network the user is looking at.
//
// Airdropped-scam handling (MAINNETS ONLY, markSuspiciousTokens): anything
// that fails services/token-spam-filter (Alchemy's price plus LiFi's
// `verified` status — Alchemy's token API has no spam flag) is MARKED
// `suspicious` rather than removed, so the picker can offer it behind an
// explicit reveal and a false positive is never a dead end. Test networks are
// never marked: nothing there is priced, so the rules would flag the very
// tokens a tester needs.
import { ALCHEMY_KEY } from '@/config/env';
import { getChainConfig, isTestnetChain, supportedEvmChainIds, usesCustomRpc } from '@/config/chains';
import { getActionableTokens } from '@/config/tokens';
import { partitionSpamTokens } from '@/services/token-spam-filter';

const ALCHEMY_NETWORK_BY_CHAIN: Record<number, string> = {
  1: 'eth-mainnet',
  10: 'opt-mainnet',
  56: 'bnb-mainnet',
  137: 'polygon-mainnet',
  8453: 'base-mainnet',
  42161: 'arb-mainnet',
  4663: 'robinhood-mainnet',
  11155111: 'eth-sepolia',
};

/**
 * Major mainnets the wallet is scanned on even where this build has no pool
 * (DEV-521: ETH on Optimism was missing from the Shield picker because only
 * pool chains were ever asked for). Rows on them are listed with their balance
 * and USD value but are not selectable here.
 */
const HOLDINGS_CHAINS: Record<number, { name: string; nativeSymbol: string }> = {
  1: { name: 'Ethereum', nativeSymbol: 'ETH' },
  10: { name: 'Optimism', nativeSymbol: 'ETH' },
  56: { name: 'BNB Chain', nativeSymbol: 'BNB' },
  137: { name: 'Polygon', nativeSymbol: 'POL' },
  8453: { name: 'Base', nativeSymbol: 'ETH' },
  42161: { name: 'Arbitrum', nativeSymbol: 'ETH' },
};

export interface WalletToken {
  symbol: string;
  name: string;
  /** 0xeee… sentinel for native, ERC-20 address otherwise (lowercase). */
  address: string;
  decimals: number;
  /** Raw balance in wei units. */
  balance: bigint;
  /** USD value when Alchemy priced it (testnets usually not). */
  usdValue: number | null;
  /** Read on-chain through the user's own RPC: no price source was asked. */
  priceUnknown?: boolean;
  /**
   * Alchemy's logo URL for the token, https only. The pickers render it for
   * assets this app has no hand-drawn mark for; without it every wallet token
   * wore the ETH glyph (Matthew, fxUSD on mainnet, 2026-09-04).
   */
  logoUrl?: string;
  /**
   * Looks like an airdropped scam / impersonator (services/token-spam-filter).
   * Set on MAINNETS only. Callers hide these behind an explicit reveal rather
   * than dropping them, so a false positive is never a dead end.
   */
  suspicious?: boolean;
}

const NATIVE_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

// Alchemy pages at 100 rows. An airdrop-heavy wallet fills the first pages with
// junk, so a few are read before giving up on the tail.
const MAX_PAGES = 5;

interface AlchemyTokenRow {
  network?: string;
  tokenAddress: string | null;
  tokenBalance: string;
  tokenMetadata?: { symbol?: string | null; name?: string | null; decimals?: number | null; logo?: string | null };
  tokenPrices?: { currency: string; value: string }[];
}

export function alchemySupportsChain(chainId: number): boolean {
  return !!ALCHEMY_KEY && ALCHEMY_NETWORK_BY_CHAIN[chainId] !== undefined;
}

/**
 * Holdings-only chains: a major mainnet with no pool in this build, scanned on
 * a MAINNET build only (a test build has no use for mainnet balances). A build
 * constant, so it rides the same single fixed-cadence request as the pool
 * chains and says nothing about what the user is looking at.
 */
export const HOLDINGS_ONLY_CHAIN_IDS: readonly number[] = supportedEvmChainIds.some((id) => !isTestnetChain(id))
  ? Object.keys(HOLDINGS_CHAINS).map(Number)
    .filter((id) => !supportedEvmChainIds.includes(id) && alchemySupportsChain(id))
  : [];

export function isHoldingsOnlyChain(chainId: number): boolean {
  return HOLDINGS_ONLY_CHAIN_IDS.includes(chainId);
}

/** Display name of a holdings-only chain (it has no chain config in this build). */
export function holdingsChainName(chainId: number): string | undefined {
  return HOLDINGS_CHAINS[chainId]?.name;
}

/** The chains this build lists wallet tokens for THROUGH ALCHEMY: a build constant, never the session's. */
export const WALLET_TOKEN_CHAIN_IDS: readonly number[] = [
  ...supportedEvmChainIds.filter(alchemySupportsChain),
  ...HOLDINGS_ONLY_CHAIN_IDS,
];

/**
 * Mainnets read on-chain through the user's own RPC instead of Alchemy
 * (services/wallet-tokens-onchain), over LiFi's verified list. Derived from
 * `supportedEvmChainIds` directly, NOT from `WALLET_TOKEN_CHAIN_IDS`: that
 * list is gated on `ALCHEMY_KEY`, and a keyless build still has every chain's
 * custom-RPC override active, so gating this on the same key silently dropped
 * custom-RPC wallet holdings the moment a build shipped without one (codex
 * P2).
 */
const CUSTOM_RPC_MAINNET_IDS: readonly number[] = supportedEvmChainIds.filter(
  (id) => !isTestnetChain(id) && usesCustomRpc(id),
);

/**
 * Mainnets this build needs LiFi's verified list for: every Alchemy-served
 * mainnet PLUS every custom-RPC mainnet, so a keyless build still fetches (and
 * the public-feed grid still registers, services/public-feeds.ts) the feed
 * that on-chain holdings are read against.
 */
export const WALLET_TOKEN_MAINNET_IDS: readonly number[] = [
  ...new Set([
    ...WALLET_TOKEN_CHAIN_IDS.filter((id) => !isTestnetChain(id) || HOLDINGS_ONLY_CHAIN_IDS.includes(id)),
    ...CUSTOM_RPC_MAINNET_IDS,
  ]),
];

/**
 * A chain the user pointed at their own RPC is never asked about through
 * Alchemy: its holdings are read on-chain through that RPC instead. A test
 * network has no verified-token list, so with a custom RPC it lists pool
 * assets only.
 */
export const ALCHEMY_WALLET_CHAIN_IDS: readonly number[] = WALLET_TOKEN_CHAIN_IDS.filter((id) => !usesCustomRpc(id));
export const ONCHAIN_WALLET_CHAIN_IDS: readonly number[] = CUSTOM_RPC_MAINNET_IDS;

/** Only an https URL is worth rendering; anything else (data:, http:, junk) is dropped. */
export function safeLogoUrl(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  return /^https:\/\/[^\s"'<>]+$/i.test(value) ? value : undefined;
}

/**
 * Non-zero wallet holdings on every chain in `chainIds` Alchemy serves, keyed
 * by chain, largest USD first. Unmarked: markSuspiciousTokens applies the spam
 * rules once LiFi's list is at hand. Throws when nothing could be read.
 */
export async function fetchWalletTokensByChain(
  ownerAddress: string,
  chainIds: readonly number[],
  signal?: AbortSignal,
): Promise<Record<number, WalletToken[]>> {
  const chainByNetwork = new Map<string, number>();
  for (const id of chainIds) {
    const network = ALCHEMY_NETWORK_BY_CHAIN[id];
    if (network) chainByNetwork.set(network, id);
  }
  if (!ALCHEMY_KEY || chainByNetwork.size === 0) return {};
  const rows: AlchemyTokenRow[] = [];
  let pageKey: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(`https://api.g.alchemy.com/data/v1/${ALCHEMY_KEY}/assets/tokens/by-address`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        addresses: [{ address: ownerAddress, networks: [...chainByNetwork.keys()] }],
        withMetadata: true,
        withPrices: true,
        ...(pageKey ? { pageKey } : {}),
      }),
      signal: signal ?? (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(10_000) : undefined),
    });
    if (!res.ok) {
      if (page === 0) throw new Error(`Alchemy tokens ${res.status}`);
      break;
    }
    const data = (await res.json()) as { data?: { tokens?: AlchemyTokenRow[]; pageKey?: string | null } };
    rows.push(...(data.data?.tokens ?? []));
    pageKey = data.data?.pageKey ?? undefined;
    if (!pageKey) break;
  }
  return parseAlchemyTokenRows(rows, chainByNetwork);
}

export function parseAlchemyTokenRows(
  rows: AlchemyTokenRow[],
  chainByNetwork: ReadonlyMap<string, number>,
): Record<number, WalletToken[]> {
  const out: Record<number, WalletToken[]> = {};
  for (const id of chainByNetwork.values()) out[id] = [];
  for (const row of rows) {
    const chainId = row.network ? chainByNetwork.get(row.network) : undefined;
    if (chainId === undefined) continue;
    let balance: bigint;
    try { balance = BigInt(row.tokenBalance); } catch { continue; }
    if (balance <= 0n) continue;
    const isNative = row.tokenAddress == null;
    const decimals = isNative ? 18 : row.tokenMetadata?.decimals ?? null;
    const symbol = isNative ? nativeSymbolFor(chainId) : row.tokenMetadata?.symbol ?? null;
    // No metadata = unpriceable spam more often than not; skip.
    if (decimals == null || decimals < 0 || decimals > 36 || !symbol) continue;
    const priceRow = row.tokenPrices?.find((p) => p.currency?.toLowerCase() === 'usd');
    const price = priceRow ? parseFloat(priceRow.value) : NaN;
    const usdValue = Number.isFinite(price)
      ? price * Number(balance) / 10 ** decimals
      : null;
    out[chainId].push({
      symbol,
      name: (isNative ? null : row.tokenMetadata?.name) ?? symbol,
      address: isNative ? NATIVE_SENTINEL : (row.tokenAddress as string).toLowerCase(),
      decimals,
      balance,
      usdValue,
      logoUrl: safeLogoUrl(isNative ? null : row.tokenMetadata?.logo),
    });
  }
  for (const tokens of Object.values(out)) tokens.sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0));
  return out;
}

/**
 * Mark airdropped scams / impersonators on one chain's holdings — MAINNETS
 * ONLY (Pat, 2026-08-18): nothing on a test network is priced, so the rules
 * would hide the very test tokens a tester needs. `verified` is LiFi's list
 * for the chain, null while it is unavailable (then only configured assets
 * pass). Safe rows first, each side by value: the picker shows the safe ones
 * and keeps the rest behind its reveal.
 */
export function markSuspiciousTokens(
  tokens: WalletToken[],
  chainId: number,
  verified: ReadonlySet<string> | null,
): WalletToken[] {
  // A holdings-only chain has no config here, so isTestnetChain fails closed
  // on it; it is a mainnet and gets the spam rules.
  if (isTestnetChain(chainId) && !HOLDINGS_ONLY_CHAIN_IDS.includes(chainId)) return tokens;
  const { suspicious } = partitionSpamTokens(
    tokens,
    // A holdings-only chain has no catalog: getActionableTokens would hand back
    // the fallback chain's, and its USDC/USDT addresses made the real USDC on
    // Base or Optimism look like an impersonator.
    HOLDINGS_ONLY_CHAIN_IDS.includes(chainId)
      ? []
      : getActionableTokens(chainId).map((t) => ({ symbol: t.symbol, address: t.address })),
    verified,
  );
  const flagged = new Set(suspicious);
  return tokens
    .map((token) => (flagged.has(token) ? { ...token, suspicious: true } : token))
    .sort((a, b) => Number(!!a.suspicious) - Number(!!b.suspicious) || (b.usdValue ?? 0) - (a.usdValue ?? 0));
}

export function nativeSymbolFor(chainId: number): string {
  return getChainConfig(chainId)?.nativeCurrency.symbol ?? HOLDINGS_CHAINS[chainId]?.nativeSymbol ?? 'ETH';
}

/**
 * Every chain the Shield pay sheet lists wallet rows for: the Alchemy-served
 * ones plus those read on-chain (a custom RPC). A build constant, like both halves.
 */
export const WALLET_ROW_CHAIN_IDS: readonly number[] = [
  ...new Set([...WALLET_TOKEN_CHAIN_IDS, ...ONCHAIN_WALLET_CHAIN_IDS]),
];
