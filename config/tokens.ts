import { sameSymbol } from '@/services/symbol-match';
import { getChainConfig } from '@/config/chains';
import { ACTIVE_ENVIRONMENT, NATIVE_ASSET_ADDRESS, type TokenMetadata } from '@/config/environments';
import { isConfiguredYieldUnderlying } from '@/config/yield';

// The token registry and the native sentinel live with the environment
// records (config/environments.ts): prod and staging each carry their own
// per-chain catalog, and a screen only ever sees the active one. Re-exported
// so every existing import path is unchanged.
export { NATIVE_ASSET_ADDRESS };
export type { TokenMetadata };

// The active environment's per-chain catalog. Prod and staging deploy on the
// same chain ids with different asset sets (prod BSC has FDUSD; staging Citrea
// and prod Citrea both have cBTC only), so this is never a merged view.
const KNOWN_TOKENS_BY_CHAIN = ACTIVE_ENVIRONMENT.tokensByChain;
// Catalog that stands in for an unknown chain id (Sepolia in staging, as
// before; mainnet in prod, which has no Sepolia).
const FALLBACK_TOKENS: Record<string, TokenMetadata> =
  KNOWN_TOKENS_BY_CHAIN[ACTIVE_ENVIRONMENT.fallbackTokenChainId] ?? {};

function fallbackSymbol(tokenAddress: string, chainId?: number): string {
  if (tokenAddress.toLowerCase() === NATIVE_ASSET_ADDRESS.toLowerCase()) {
    return getChainConfig(chainId ?? 1)?.nativeCurrency.symbol ?? 'ETH';
  }
  return tokenAddress.slice(0, 6).toUpperCase();
}

// A Move coin type ("0x2::sui::SUI", possibly with the address zero-padded to
// 32 bytes) — never an EVM address, so resolve it structurally instead of
// truncating it into labels like "0X2::S".
function suiCoinTypeMetadata(tokenAddress: string): TokenMetadata | undefined {
  if (!tokenAddress.includes('::')) return undefined;
  const [addr, module_, struct] = tokenAddress.split('::');
  const isNativeSui =
    /^0x0*2$/.test(addr ?? '') && module_ === 'sui' && (struct ?? '').toUpperCase() === 'SUI';
  if (isNativeSui) {
    return { symbol: 'SUI', address: tokenAddress, decimals: 9, isNative: true };
  }
  return {
    symbol: (struct || module_ || 'SUI').toUpperCase(),
    address: tokenAddress,
    decimals: 9,
    isNative: false,
  };
}

export function getTokenMetadata(tokenAddress: string, chainId?: number): TokenMetadata {
  const suiCoin = suiCoinTypeMetadata(tokenAddress);
  if (suiCoin) return suiCoin;

  const normalizedAddress = tokenAddress.toLowerCase();
  const chainTokens = chainId ? KNOWN_TOKENS_BY_CHAIN[chainId] : undefined;
  const knownToken = chainTokens?.[normalizedAddress];
  if (knownToken) {
    return knownToken;
  }

  const isNative = normalizedAddress === NATIVE_ASSET_ADDRESS.toLowerCase();
  return {
    symbol: fallbackSymbol(tokenAddress, chainId),
    address: tokenAddress,
    decimals: isNative ? 18 : 18,
    isNative,
  };
}

/**
 * Strict variant of {@link getTokenMetadata}: only tokens actually present in
 * the per-chain known registry (or structurally-native Sui coin types) —
 * NO fallback metadata. Use when acting on a token (e.g. re-issuing a
 * payment request) where a guessed symbol/decimals would silently produce a
 * request for the wrong asset.
 */
/**
 * Resolve a token across EVERY chain registry — for payloads that carry no
 * chainId (note receipts are bare AccountExports). First registry hit wins;
 * ambiguity is safe because symbols/decimals agree across our chains for the
 * same asset class. Falls back to {@link getTokenMetadata}'s default-chain
 * fallback (which guesses 18 decimals) only when NO chain knows the address.
 */
export function getTokenMetadataAnyChain(tokenAddress: string, fallbackChainId: number): TokenMetadata {
  const normalized = tokenAddress.toLowerCase();
  for (const registry of Object.values(KNOWN_TOKENS_BY_CHAIN)) {
    const hit = registry[normalized];
    if (hit) return hit;
  }
  return getTokenMetadata(tokenAddress, fallbackChainId);
}

export function getKnownTokenMetadata(tokenAddress: string, chainId: number): TokenMetadata | undefined {
  const suiCoin = suiCoinTypeMetadata(tokenAddress);
  if (suiCoin) return suiCoin;
  return KNOWN_TOKENS_BY_CHAIN[chainId]?.[tokenAddress.toLowerCase()];
}

/**
 * The actionable token catalog for an EVM chain — what the deposit /
 * transfer / payment-request selectors offer. Native asset first (object
 * insertion order). Unknown chains fall back to the Sepolia catalog so the
 * mainline build's behaviour is unchanged; on the staging build this is what
 * keeps mainnet actions on the CANONICAL USDC/USDT contracts (not the
 * Sepolia test tokens) and Citrea on native cBTC only.
 */
export function getActionableTokens(chainId?: number): TokenMetadata[] {
  const chainTokens = (chainId != null ? KNOWN_TOKENS_BY_CHAIN[chainId] : undefined)
    ?? FALLBACK_TOKENS;
  return Object.values(chainTokens);
}

/**
 * The registry minus withdraw-only (legacy) assets: what a NEW deposit, a
 * payment request or a shield target may name. Balances, withdraw and send
 * keep using getActionableTokens so existing notes in a legacy asset remain
 * visible and spendable.
 */
export function resolveDepositableTokens(
  tokens: readonly TokenMetadata[],
  chainId: number,
  isUnderlying: (chainId: number, tokenAddress: string) => boolean,
): TokenMetadata[] {
  // A withdraw-only asset is still depositable when a yield deployment takes it
  // as underlying: plain USDC on prod goes in through the PPRouter and comes
  // out as a ppUSDC note. The Entrypoint's closed plain-USDC asset is not what
  // that deposit calls.
  //
  // `isUnderlying` is the CONFIGURED route, not the vault-verified one. The
  // probe runs at session creation, so keying the catalog on it hid USDC and
  // USDT from every picker until then, and the rows that did show read
  // "Deposits closed" on the screen where picking them deposits (Pat,
  // 2026-09-12). Nothing here moves money: the deposit re-reads the VERIFIED
  // gate at send time and refuses an unverified vault, which is where
  // fail-closed belongs.
  //
  // `depositComingSoon` is checked FIRST and has no exception: an asset whose
  // pool has not opened yet cannot be reached through a router either, so no
  // yield route may re-admit it (mainnet ETH, 2026-09-05).
  return tokens.filter((t) => !t.depositComingSoon && (!t.withdrawOnly || isUnderlying(chainId, t.address)));
}

/**
 * Assets this chain will take deposits for, but does not yet
 * (`depositComingSoon`). Deliberately NOT part of any depositable list: it
 * exists so a picker can still SHOW the row, disabled, with the honest
 * "Available soon" line instead of hiding an asset the user came for.
 */
export function getDepositComingSoonTokens(chainId?: number): TokenMetadata[] {
  // A share is never a pay row (its underlying or coin is), so a paused vault
  // lists once, under the asset the user pays with.
  return getActionableTokens(chainId).filter((t) => t.depositComingSoon && !t.yieldShare);
}

/** True when deposits for this asset are not open yet on this chain. */
export function isDepositComingSoon(tokenAddress: string, chainId: number): boolean {
  return getKnownTokenMetadata(tokenAddress, chainId)?.depositComingSoon === true;
}

/**
 * Assets a plain Entrypoint deposit may target: never a withdraw-only one,
 * verified yield or not. For routes that only know the Entrypoint (payment
 * requests paid from a wallet, swap-into-deposit); the direct Shield path,
 * which can wrap through the PPRouter, uses getDepositableTokens.
 */
export function getEntrypointDepositableTokens(chainId?: number): TokenMetadata[] {
  return getActionableTokens(chainId).filter((t) => !t.withdrawOnly && !t.depositComingSoon);
}

export function getDepositableTokens(chainId?: number): TokenMetadata[] {
  return resolveDepositableTokens(
    getActionableTokens(chainId),
    chainId ?? ACTIVE_ENVIRONMENT.fallbackTokenChainId,
    isConfiguredYieldUnderlying,
  );
}

export function getTokenMetadataBySymbol(symbol: string, chainId?: number): TokenMetadata | undefined {
  const normalizedSymbol = symbol.toUpperCase();
  const chainTokens = chainId ? KNOWN_TOKENS_BY_CHAIN[chainId] : FALLBACK_TOKENS;
  // Case-insensitive on BOTH sides: mixed-case symbols (Citrea's native
  // "cBTC") must still match, or the native asset falls through to the
  // fallback path and gets treated as an ERC-20 with a junk address.
  return Object.values(chainTokens ?? {}).find((token) => sameSymbol(token.symbol, normalizedSymbol));
}

// Resolve metadata from EITHER a 0x address or a bare symbol. The ASP is
// inconsistent about `tokenSymbol`: /events returns the token address in
// that field, while /token-prices returns the real symbol ("USDC"). Code
// that fed an ASP `tokenSymbol` straight into address-only
// getTokenMetadata() created phantom entries keyed by the raw symbol
// string ("usdc") that never matched the real-address entries — e.g. the
// duplicate $0 pools. Use this when the input may be either form.
export function resolveTokenMetadata(symbolOrAddress: string | undefined | null, chainId?: number): TokenMetadata {
  // Defensive: some ASP price rows arrive with a missing/empty
  // tokenSymbol. Never throw here — this runs inside a render-time
  // useMemo, so a throw white-screens the whole app.
  if (!symbolOrAddress) {
    return { symbol: '', address: '', decimals: 18, isNative: false };
  }
  if (symbolOrAddress.startsWith('0x')) {
    return getTokenMetadata(symbolOrAddress, chainId);
  }
  return getTokenMetadataBySymbol(symbolOrAddress, chainId) ?? getTokenMetadata(symbolOrAddress, chainId);
}

// Formatting lives in services/token-format.ts so it can be TESTED: this file
// imports config/chains.ts, which reaches react-native, and the bun runner
// cannot parse that package's Flow syntax. Re-exported here so every existing
// caller and import path is unchanged.
export { isStablecoin, formatTokenBalance } from '@/services/token-format';

