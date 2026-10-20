// Airdropped-scam filtering for the wallet's token list.
//
// Alchemy's Portfolio API (`assets/tokens/by-address`) carries NO spam signal:
// a row is exactly { address, network, tokenAddress, tokenBalance,
// tokenMetadata: {symbol,name,decimals,logo}, tokenPrices } — no `isSpam`, no
// `verified`, and the `excludeSpam` / `withSpam` / `filterSpam` parameters are
// silently ignored (probed 2026-08-18). Alchemy's spam detection is NFT-only
// (`isSpamContract` / `spamInfo` on the NFT API).
//
// So the signal has to come from the data itself. On a real wallet the split is
// stark — every legitimate holding is PRICED by Alchemy, and every airdropped
// token is not:
//
//   ETH ✓priced   WBTC ✓priced   USDC(real) ✓priced
//   DOG ✗  KEB ✗  CSS ✗  GUS ✗  SUPERDOG ✗  YES ✗  TRUNK ✗  YFTE ✗  YRISE ✗
//   υՏƊⅭ ✗ (homoglyph "USDC")   USDC@0x5bb5… ✗   USDC@0x7626… ✗ (impersonators)
//
// Rules, in order of how much they protect the user:
//  1. IMPERSONATORS are dropped unconditionally — a token whose symbol matches
//     one of the chain's configured assets from an address that is NOT that
//     asset. This is the only class that can actually cost money (a user
//     shielding "USDC" that isn't USDC), so it outranks every keep-rule.
//  2. Configured assets are always kept (our own pool assets).
//  3. Deceptive metadata is dropped: non-ASCII/homoglyph or URL-bearing
//     symbols and names, absurd lengths.
//  4. Otherwise keep only what Alchemy PRICED *and* LiFi lists as `verified`
//     on that chain (services/lifi-token-list). A scam can carry a price from
//     a thin pool it seeded itself; it rarely also passes LiFi's screening.
//     Without the LiFi list (fetch failed) nothing passes this rule. A row
//     read on-chain through the user's own RPC has no price source, so there
//     LiFi's verification decides alone.
//
// Nothing here is a verdict on the token: a filtered-out asset is still
// reachable by pasting its address into the same sheet, which resolves it
// on-chain. Testnets price nothing, so there the list is the configured
// assets — which is all a testnet pay-picker can usefully offer anyway.

export interface SpamFilterToken {
  symbol: string;
  name: string;
  /** Lowercase address, or the native sentinel. */
  address: string;
  /** Alchemy's USD valuation, null when it could not price the token. */
  usdValue: number | null;
  /**
   * No price source was asked: the row was read on-chain through the user's
   * own RPC instead of Alchemy. Rule 4 then rests on LiFi's verification alone.
   */
  priceUnknown?: boolean;
}

export interface KnownAsset {
  symbol: string;
  address: string;
}

/** Symbols/names that only a scam bothers to encode: links and payloads. */
const DECEPTIVE_TEXT_RE = /(https?:\/\/|www\.|\.com|\.io|\.xyz|\.finance|claim|airdrop|reward|visit|free)/i;
/** Anything outside printable ASCII: homoglyph impersonation ("υՏƊⅭ"). */
const NON_ASCII_RE = /[^\x20-\x7E]/;

const MAX_SYMBOL_LENGTH = 12;
const MAX_NAME_LENGTH = 40;

function deceptive(token: SpamFilterToken): boolean {
  const { symbol, name } = token;
  if (!symbol) return true;
  if (NON_ASCII_RE.test(symbol) || NON_ASCII_RE.test(name)) return true;
  if (symbol.length > MAX_SYMBOL_LENGTH || name.length > MAX_NAME_LENGTH) return true;
  // A URL in the SYMBOL is always a payload; in the name it is nearly always
  // one ("Visit x.com to claim"), and no configured asset carries either —
  // configured assets never reach this check anyway (rule 2 runs first).
  return DECEPTIVE_TEXT_RE.test(symbol) || DECEPTIVE_TEXT_RE.test(name);
}

/**
 * Split the holdings into the ones worth offering and the ones that look like
 * airdropped scams, so a caller can hide the latter behind an explicit reveal
 * rather than dropping them on the floor. `known` is the chain's configured
 * asset catalog (config/tokens getActionableTokens).
 */
export function partitionSpamTokens<T extends SpamFilterToken>(
  tokens: T[],
  known: KnownAsset[],
  verified: ReadonlySet<string> | null,
): { safe: T[]; suspicious: T[] } {
  const safe: T[] = [];
  const suspicious: T[] = [];
  const keep = new Set(filterSpamTokens(tokens, known, verified));
  for (const token of tokens) (keep.has(token) ? safe : suspicious).push(token);
  return { safe, suspicious };
}

/**
 * Keep the holdings worth offering, drop airdropped scams. `known` is the
 * chain's configured asset catalog (config/tokens getActionableTokens);
 * `verified` is LiFi's verified addresses for the chain, lowercase, or null
 * when the list is unavailable.
 */
export function filterSpamTokens<T extends SpamFilterToken>(
  tokens: T[],
  known: KnownAsset[],
  verified: ReadonlySet<string> | null,
): T[] {
  const knownByAddress = new Set(known.map((k) => k.address.toLowerCase()));
  const knownSymbols = new Map<string, string>();
  for (const k of known) knownSymbols.set(k.symbol.toUpperCase(), k.address.toLowerCase());

  return tokens.filter((token) => {
    const address = token.address.toLowerCase();
    const isConfigured = knownByAddress.has(address);

    // 1. Impersonation: our own symbol, someone else's contract.
    const configuredAddressForSymbol = knownSymbols.get(token.symbol.toUpperCase());
    if (configuredAddressForSymbol && configuredAddressForSymbol !== address) return false;

    // 2. Our configured assets always survive (a pool asset the user holds
    //    nothing of still belongs in the picker).
    if (isConfigured) return true;

    // 3. Metadata that exists to deceive.
    if (deceptive(token)) return false;

    // 4. Real market data and LiFi's verification, or nothing.
    return (token.usdValue != null || !!token.priceUnknown) && !!verified?.has(address);
  });
}
