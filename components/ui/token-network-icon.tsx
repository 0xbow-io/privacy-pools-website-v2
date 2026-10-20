import React from 'react';
import { Image, Text, View } from 'react-native';
import Svg, { Path, Circle } from 'react-native-svg';
import { SuiTokenMark } from './sui-token-mark';
import { ChainLogo, TestnetPill, chainLogoChainFor } from './chain-logo';
import { isTestnetChain, SUI_TESTNET_ID } from '@/config/chains';
import { displayTokenSymbol } from '@/services/share-display';

// Shared token logo + overlaid network badge — same visual the All Pools table
// uses (token mark with a small chain badge bottom-right). Reused by the
// deposit token/network selector. Network is Sepolia for now (ETH mark).
// nw-keep(svg-or-canvas): the token marks below are fixed brand palettes on SVG paints (fill props), not theme tokens.

function EthMark({ size = 20 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <Circle cx={10} cy={10} r={10} fill="#627EEA" />
      <Path d="M10 4L10 8.5L13.5 10L10 4Z" fill="#C0CBF6" />
      <Path d="M10 4L6.5 10L10 8.5L10 4Z" fill="white" />
      <Path d="M10 12.5L10 16L13.5 10.75L10 12.5Z" fill="#C0CBF6" />
      <Path d="M10 16L10 12.5L6.5 10.75L10 16Z" fill="white" />
      <Path d="M10 11.75L13.5 10L10 8.5L10 11.75Z" fill="#8197EE" />
      <Path d="M6.5 10L10 11.75L10 8.5L6.5 10Z" fill="#C0CBF6" />
    </Svg>
  );
}

function UsdcMark({ size = 20 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <Circle cx={16} cy={16} r={16} fill="#3E73C4" />
      <Path d="M20.022 18.124c0-2.124-1.28-2.852-3.84-3.156-1.828-.243-2.193-.728-2.193-1.578 0-.85.61-1.396 1.828-1.396 1.097 0 1.707.364 2.011 1.275a.458.458 0 00.427.303h.975a.416.416 0 00.427-.425v-.06a3.04 3.04 0 00-2.743-2.489V9.142c0-.243-.183-.425-.487-.486h-.915c-.243 0-.426.182-.487.486v1.396c-1.829.242-2.986 1.456-2.986 2.974 0 2.002 1.218 2.791 3.778 3.095 1.707.303 2.255.668 2.255 1.639 0 .97-.853 1.638-2.011 1.638-1.585 0-2.133-.667-2.316-1.578-.06-.242-.244-.364-.427-.364h-1.036a.416.416 0 00-.426.425v.06c.243 1.518 1.219 2.61 3.23 2.914v1.457c0 .242.183.425.487.485h.915c.243 0 .426-.182.487-.485V21.34c1.829-.303 3.047-1.578 3.047-3.217z" fill="#FFF" />
      <Path d="M12.892 24.497c-4.754-1.7-7.192-6.98-5.424-11.653.914-2.55 2.925-4.491 5.424-5.402.244-.121.365-.303.365-.607v-.85c0-.242-.121-.424-.365-.485-.061 0-.183 0-.244.06a10.895 10.895 0 00-7.13 13.717c1.096 3.4 3.717 6.01 7.13 7.102.244.121.488 0 .548-.243.061-.06.061-.122.061-.243v-.85c0-.182-.182-.424-.365-.546zm6.46-18.936c-.244-.122-.488 0-.548.242-.061.061-.061.122-.061.243v.85c0 .243.182.485.365.607 4.754 1.7 7.192 6.98 5.424 11.653-.914 2.55-2.925 4.491-5.424 5.402-.244.121-.365.303-.365.607v.85c0 .242.121.424.365.485.061 0 .183 0 .244-.06a10.895 10.895 0 007.13-13.717c-1.096-3.46-3.778-6.07-7.13-7.162z" fill="#FFF" />
    </Svg>
  );
}

function UsdtMark({ size = 20 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <Circle cx={10} cy={10} r={10} fill="#26A17B" />
      <Path d="M11 9.25V7.75H14V5.75H6V7.75H9V9.25C7 9.4 5.5 9.9 5.5 10.5C5.5 11.1 7 11.6 9 11.75V15H11V11.75C13 11.6 14.5 11.1 14.5 10.5C14.5 9.9 13 9.4 11 9.25ZM10 11C7.8 11 6 10.6 6 10.1C6 9.6 7.8 9.2 10 9.2C12.2 9.2 14 9.6 14 10.1C14 10.6 12.2 11 10 11Z" fill="white" />
    </Svg>
  );
}

/** Official BNB logo, matching the v1 website's src/assets/icons/bnb.svg. */
function BnbMark({ size = 20 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 500 500" fill="none">
      <Circle cx={250} cy={250} r={250} fill="#F0B90B" />
      <Path
        d="M250 100l75 75-45 45-30-30-30 30-45-45 75-75zm-100 100l45 45-45 45-45-45 45-45zm200 0l45 45-45 45-45-45 45-45zM250 245l45 45-45 45-45-45 45-45zm0 110l75 75-75 75-75-75 30-30 45 45 45-45 30 30-75-75z"
        fill="#fff"
      />
    </Svg>
  );
}

/** Citrea's native cBTC wears the Citrea mark, the same chip as its network. */
function CbtcMark({ size = 20 }: { size?: number }) {
  return <ChainLogo chain="citrea" size={size} />;
}

/** XLM is Stellar's native asset and wears the Stellar mark. The chain badge
 *  carries the testnet pill, so the mark itself does not draw a second one. */
function XlmMark({ size = 20 }: { size?: number }) {
  return <ChainLogo chain="stellar-testnet" size={size} testnetLabel={false} />;
}

/** A bundled PNG logo clipped to a disc, for marks with no hand-drawn SVG. */
function BundledMark({ source, size = 20 }: { source: number; size?: number }) {
  return (
    <Image
      source={source}
      accessibilityIgnoresInvertColors
      className="rounded-full"
      // nw-keep(svg-or-canvas): prop-driven geometry — the size prop scales the image
      style={{ width: size, height: size }}
    />
  );
}

// Official logos from the Trust Wallet token list (BSC contracts
// 0xc5f0f7b6…6409 and 0xcE24439F…6666); both drew the letter mark before.
const FDUSD_LOGO = require('@/assets/images/tokens/fdusd.png');
const U_LOGO = require('@/assets/images/tokens/u.png');

function FdusdMark({ size = 20 }: { size?: number }) {
  return <BundledMark source={FDUSD_LOGO} size={size} />;
}

/** United Stables (U) on BNB Chain. */
function UMark({ size = 20 }: { size?: number }) {
  return <BundledMark source={U_LOGO} size={size} />;
}

const TOKEN_MARKS: Record<string, (props: { size?: number }) => React.JSX.Element> = {
  ETH: EthMark,
  USDC: UsdcMark,
  USDT: UsdtMark,
  // Without this a BNB balance drew the Ethereum mark as its TOKEN icon, which
  // the chain badge fix above would not have covered: the badge says which
  // network, the mark says which asset.
  BNB: BnbMark,
  SUI: SuiTokenMark,
  // Without it the balances row drew the ETH glyph for cBTC (Mike, 2026-09-24).
  CBTC: CbtcMark,
  XLM: XlmMark,
  FDUSD: FdusdMark,
  U: UMark,
  // The prod pool stables are the Aave yield wrappers; they wear the mark of
  // the underlying they track 1:1 (2026-09-04).
  // Keys are UPPERCASE: the lookup upper-cases the symbol (a mixed-case key
  // here left the pp shares on the letter mark, 2026-09-04).
  PPUSDC: UsdcMark,
  PPUSDT: UsdtMark,
  // ppETH (mainnet, 2026-09-18) tracks WETH 1:1; the user knows it as ETH.
  PPETH: EthMark,
};

/**
 * The network badge that sits bottom-right of a token mark. Exported so
 * callers with their own base artwork (e.g. a PNG pool logo) get the identical
 * treatment instead of re-deriving the circle geometry.
 *
 * Test networks carry the same yellow "testnet" pill as the network selector
 * (truncated at this size, like the selector's own chip): a Sepolia asset must
 * never read as plain Ethereum. Only when the chain is KNOWN — an absent
 * chainId renders no pill rather than guessing the default chain, which
 * stamped "testnet" onto mainnet chips on multi-chain builds.
 */
export function ChainBadge({
  size,
  chainId,
  symbol,
  testnetLabel = true,
}: {
  size: number;
  chainId?: number;
  symbol?: string;
  /**
   * Render the "testnet" watermark. Callers whose surrounding text already
   * names the chain (the hub's selector pills) turn it off — at badge sizes
   * the truncated watermark covers the chain mark instead of labelling it.
   */
  testnetLabel?: boolean;
}) {
  const upper = (symbol || '').toUpperCase();
  const badgeChainId = upper === 'SUI' ? SUI_TESTNET_ID : chainId;
  const testnet = testnetLabel && badgeChainId !== undefined && isTestnetChain(badgeChainId);
  return (
    <View
      className="absolute -bottom-[3px] -right-[3px]"
      // nw-keep(svg-or-canvas): prop-derived badge geometry (half the mark size); the pill hangs outside the circle, so overflow stays visible here
      style={{ width: size, height: size }}
    >
      <View
        className="items-center justify-center overflow-hidden border-[1.5px] border-[#FFFFFF] bg-[#FFFFFF]"
        // nw-keep(svg-or-canvas): prop-derived badge circle geometry (half the mark size)
        style={{ width: size, height: size, borderRadius: size }}
      >
        {/* One source of truth for "which mark does this chain wear".
            This used to be a hardcoded ladder that named Optimism and fell
            back to Ethereum, so Citrea and BNB tokens wore the Ethereum badge
            here even after the network selector learned their marks
            (Pat, 2026-08-28). chainLogoChainFor already answers this for every
            chain; ethereum/sepolia keep EthMark because the badge draws its
            own testnet pill and ChainLogo would draw a second one. */}
        {upper === 'SUI' ? (
          <SuiTokenMark size={size - 2} />
        ) : badgeChainId !== undefined && !['ethereum', 'sepolia', 'sui-testnet'].includes(chainLogoChainFor(badgeChainId)) ? (
          <ChainLogo chain={chainLogoChainFor(badgeChainId)} size={size - 2} testnetLabel={false} />
        ) : (
          <EthMark size={size - 2} />
        )}
      </View>
      {testnet && <TestnetPill size={size} />}
    </View>
  );
}

/**
 * Token logo with the network badge overlaid bottom-right. `chainId` picks the
 * badge mark; without it the badge falls back to Ethereum (SUI is self-badging,
 * since it only exists on the Sui network). Mirrors the All Pools table icon.
 */
/**
 * Neutral mark for a token this app has no artwork for: its first letters on
 * a muted disc. Replaces the old fallback to the ETH glyph, which dressed
 * every unknown wallet token (fxUSD, LINK, ...) as Ether.
 */
function LetterMark({ symbol, size = 20 }: { symbol: string; size?: number }) {
  const letters = (symbol || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
  return (
    <View
      className="items-center justify-center rounded-full bg-surface-raised border border-border-light"
      // nw-keep(svg-or-canvas): prop-driven geometry — the size prop scales the disc
      style={{ width: size, height: size }}
    >
      <Text
        className="font-pp-semi-bold text-text-secondary"
        // nw-keep(svg-or-canvas): font size derives from the mark size
        style={{ fontSize: Math.max(8, Math.round(size * 0.38)), lineHeight: Math.round(size * 0.5) }}
      >
        {letters}
      </Text>
    </View>
  );
}

/** A remote logo (Alchemy / token list URL), clipped to a disc. */
function RemoteMark({ uri, size = 20 }: { uri: string; size?: number }) {
  return (
    <Image
      source={{ uri }}
      accessibilityIgnoresInvertColors
      className="rounded-full"
      // nw-keep(svg-or-canvas): prop-driven geometry — the size prop scales the image
      style={{ width: size, height: size }}
    />
  );
}

/** Whether the shared marks carry artwork for this symbol (shares resolve to their underlying). */
export function hasTokenMark(symbol: string): boolean {
  return !!TOKEN_MARKS[displayTokenSymbol((symbol || '').toUpperCase()).toUpperCase()];
}

/**
 * The token's own mark with no network badge, for small inline chips that sit
 * on one network already (the hub's asset chips drew a coloured dot, Mike,
 * 2026-09-24: "still no logos there").
 */
export function TokenMark({ symbol, size = 14 }: { symbol: string; size?: number }) {
  const upper = (symbol || '').toUpperCase();
  const Mark = TOKEN_MARKS[displayTokenSymbol(upper).toUpperCase()];
  return Mark ? <Mark size={size} /> : <LetterMark symbol={upper} size={size} />;
}

export function TokenNetworkIcon({
  symbol,
  size = 28,
  chainId,
  badgeSize,
  badgeTestnetLabel = true,
  logoUri,
}: {
  symbol: string;
  size?: number;
  chainId?: number;
  /** Chain-badge diameter; defaults to half the mark size. */
  badgeSize?: number;
  /** See ChainBadge.testnetLabel. */
  badgeTestnetLabel?: boolean;
  /**
   * Remote logo for a token without a hand-drawn mark (wallet tokens from
   * Alchemy). Ignored when the symbol has its own artwork, so a lookalike
   * cannot restyle a pool asset.
   */
  logoUri?: string;
}) {
  const upper = (symbol || '').toUpperCase();
  // A yield share wears its UNDERLYING's artwork: ppUSDC is USDC held a
  // certain way, not a different coin, and an unknown symbol here fell to a
  // letter mark (or, at other sites, the ETH glyph) (Pat, 2026-09-05).
  const Mark = TOKEN_MARKS[displayTokenSymbol(upper).toUpperCase()];
  return (
    <View
      className="relative items-center justify-center"
      // nw-keep(svg-or-canvas): prop-driven geometry — the size prop scales the mark wrapper
      style={{ width: size, height: size }}
    >
      {Mark ? <Mark size={size} /> : logoUri ? <RemoteMark uri={logoUri} size={size} /> : <LetterMark symbol={upper} size={size} />}
      <ChainBadge size={badgeSize ?? Math.round(size * 0.5)} chainId={chainId} symbol={upper} testnetLabel={badgeTestnetLabel} />
    </View>
  );
}
