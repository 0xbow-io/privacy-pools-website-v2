import { TOR_IN_FORCE } from '@/config/tor';
import React from 'react';
import { DaiTokenIcon, EtcTokenIcon, CbtcTokenIcon, UsdgIcon, UsdcTokenIcon as UsdcMark, UsdtTokenIcon as UsdtMark } from './token-icons';
import { Image, Text, View } from 'react-native';
import Svg, { Path, Circle } from 'react-native-svg';
import { SuiTokenMark } from './sui-token-mark';
import { ChainLogo, TestnetPill, chainLogoChainFor } from './chain-logo';
import { isTestnetChain, SUI_TESTNET_ID } from '@/config/chains';
import { displayTokenSymbol } from '@/services/share-display';

// Shared token logo + overlaid network badge — same visual the All Pools table
// uses (token mark with a small chain badge bottom-right). Reused by the
// deposit token/network selector. Each caller supplies the actual chain.
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


/** BNB's native token shares the official network artwork. */
function BnbMark({ size = 20 }: { size?: number }) {
  return <ChainLogo chain="bnb" size={size} />;
}

/** XLM is Stellar's native asset and wears the Stellar mark. The chain badge
 *  carries the testnet pill, so the mark itself does not draw a second one. */
function XlmMark({ size = 20 }: { size?: number }) {
  return <ChainLogo chain="stellar-testnet" size={size} testnetLabel={false} />;
}

/** Bundled official raster artwork, preserving its original aspect ratio. */
function BundledMark({ source, size = 20 }: { source: number; size?: number }) {
  return (
    <Image
      source={source}
      accessibilityIgnoresInvertColors
      resizeMode="contain"
      // nw-keep(svg-or-canvas): prop-driven geometry — the size prop scales the image
      style={{ width: size, height: size }}
    />
  );
}

// Official token symbols: firstdigitallabs.com/brand-assets and u.tech/resources/brand-kit/logos/.
const FDUSD_LOGO = require('@/assets/images/tokens/fdusd.png');
const U_LOGO = require('@/assets/images/tokens/u.png');

function FdusdMark({ size = 20 }: { size?: number }) {
  return <BundledMark source={FDUSD_LOGO} size={size} />;
}

/** United Stables (U) on BNB Chain. */
function UMark({ size = 20 }: { size?: number }) {
  return (
    <View className="items-center justify-center rounded-full"
      // nw-keep(data-color): dark logo-card background from United Stables' brand kit.
      // nw-keep(svg-or-canvas): prop-driven circle and inset preserve the logo proportions.
      style={{ width: size, height: size, backgroundColor: '#111111' }}>
      <BundledMark source={U_LOGO} size={size * 0.62} />
    </View>
  );
}

export const TOKEN_MARKS: Record<string, (props: { size?: number }) => React.JSX.Element> = {
  ETH: EthMark,
  DAI: DaiTokenIcon,
  ETC: EtcTokenIcon,
  USDC: UsdcMark,
  USDG: UsdgIcon,
  USDT: UsdtMark,
  // Without this a BNB balance drew the Ethereum mark as its TOKEN icon, which
  // the chain badge fix above would not have covered: the badge says which
  // network, the mark says which asset.
  BNB: BnbMark,
  SUI: SuiTokenMark,
  // Without it the balances row drew the ETH glyph for cBTC (Mike, 2026-09-24).
  CBTC: CbtcTokenIcon,
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
  if (badgeChainId === undefined) return null;
  const testnet = testnetLabel && isTestnetChain(badgeChainId);
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
        <ChainLogo chain={chainLogoChainFor(badgeChainId)} size={size - 2} testnetLabel={false} />
      </View>
      {testnet && <TestnetPill size={size} />}
    </View>
  );
}

/**
 * Token logo with the network badge overlaid bottom-right. `chainId` picks the
 * badge mark; an unknown chain has no badge (SUI is self-badging,
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
  /** Explicit even when unknown, so callers cannot silently omit the network. */
  chainId: number | undefined;
  /** Chain-badge diameter; defaults to half the mark size plus 2px. */
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
      {/* Under anon-rpc a remote logo would load directly from its host, and
          the set of logos a page loads is the wallet's holdings: letters instead. */}
      {Mark ? <Mark size={size} /> : logoUri && !TOR_IN_FORCE ? <RemoteMark uri={logoUri} size={size} /> : <LetterMark symbol={upper} size={size} />}
      <ChainBadge size={badgeSize ?? (Math.round(size * 0.5) + 2)} chainId={chainId} symbol={upper} testnetLabel={badgeTestnetLabel} />
    </View>
  );
}
