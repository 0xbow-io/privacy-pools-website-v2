import { useEffect } from 'react';
import { TOKEN_MARKS } from '@/components/ui/token-network-icon';
import { ChainLogo } from '@/components/ui/chain-logo';
import { DaiTokenIcon, EtcTokenIcon, CbtcTokenIcon, UsdgIcon, UsdcTokenIcon as SharedUsdcTokenIcon, UsdtTokenIcon as SharedUsdtTokenIcon } from '@/components/ui/token-icons';
import { CaretDownIcon } from '@/components/ui/modal-icons';
import { Platform } from 'react-native';
import type { ViewStyle } from 'react-native';
import Svg, { Path, Circle } from 'react-native-svg';
import type { Transaction } from '@/components/pools-provider';
import { SuiTokenMark } from '@/components/ui/sui-token-mark';
import { displayTokenSymbol } from '@/services/share-display';
import { useBackHandler } from '@/hooks/use-back-handler';

/**
 * Closes any open dropdowns on Escape (web only). Each consumer passes its
 * own close handler — the parent used to manage this globally, but now each
 * extracted child owns its dropdown state.
 */
export function useEscapeToClose(close: () => void, open = false) {
  // Android back closes an open menu; while nothing is open it falls through.
  useBackHandler(open, close);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);
}

// position: 'fixed' is valid in react-native-web but not in RN's ViewStyle types.
interface WebOnlyViewStyle { position?: string }
export const WEB_FIXED_POSITION: ViewStyle & WebOnlyViewStyle = Platform.OS === 'web'
  ? { position: 'fixed' } as ViewStyle & WebOnlyViewStyle
  : {};

export type TokenIconComponent = (props: { size?: number }) => React.JSX.Element;

// nw-keep(svg-or-canvas): every icon component below carries fixed brand/chrome
// fill+stroke literals baked into its SVG artwork, plus `color`/`fill`/`stroke`
// props the caller feeds at runtime — all react-native-svg color sinks with no
// className path.
export function ChevronLeftIcon({ color = '#000000' }: { color?: string }) {
  return (
    <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <Path d="M5 8L10 3L10.7 3.7L6.4 8L10.7 12.3L10 13L5 8Z" fill={color} />
    </Svg>
  );
}


export function EthTokenIcon({ size = 20 }: { size?: number }) {
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



// DAI + WETH deliberately reuse the artwork already shipped by the row-level
// POOL_ICONS maps (my-privacy-pools.tsx / all-pools.tsx) so the same asset can
// never render two different marks across the app. Both are saturated brand
// discs with a white glyph, exactly like ETH/USDC/USDT above — they read on
// light and dark without a theme branch.

export function WethTokenIcon({ size = 20 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <Circle cx={10} cy={10} r={10} fill="#EC1C79" />
      <Path d="M10 4L10 8.5L13.5 10L10 4Z" fill="#F8A4CC" />
      <Path d="M10 4L6.5 10L10 8.5L10 4Z" fill="white" />
      <Path d="M10 12.5L10 16L13.5 10.75L10 12.5Z" fill="#F8A4CC" />
      <Path d="M10 16L10 12.5L6.5 10.75L10 16Z" fill="white" />
    </Svg>
  );
}

/** Use the same official BNB artwork as token badges and selectors. */
export function BnbTokenIcon({ size = 20 }: { size?: number }) {
  return <ChainLogo chain="bnb" size={size} />;
}


export function OverflowMenuIcon({ color = '#000000' }: { color?: string }) {
  const d = 'M8 11C8.55228 11 9 11.4477 9 12C9 12.5523 8.55228 13 8 13C7.44772 13 7 12.5523 7 12C7 11.4477 7.44772 11 8 11ZM8 7C8.55228 7 9 7.44772 9 8C9 8.55228 8.55228 9 8 9C7.44772 9 7 8.55228 7 8C7 7.44772 7.44772 7 8 7ZM8 3C8.55228 3 9 3.44772 9 4C9 4.55228 8.55228 5 8 5C7.44772 5 7 4.55228 7 4C7 3.44772 7.44772 3 8 3Z';
  return (
    <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <Path d={d} fill={color} />
      <Path d={d} fill={color} fillOpacity={0.2} />
      <Path d={d} fill={color} fillOpacity={0.2} />
      <Path d={d} fill={color} fillOpacity={0.2} />
    </Svg>
  );
}

export function DepositArrowIcon({ color = '#000000' }: { color?: string }) {
  return (
    <Svg width={20} height={20} viewBox="0 0 20 20" fill="none">
      <Path d="M10 4L10 16M10 4L5 9M10 4L15 9" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function WithdrawArrowIcon({ color = '#000000' }: { color?: string }) {
  return (
    <Svg width={20} height={20} viewBox="0 0 20 20" fill="none">
      <Path d="M10 16L10 4M10 16L5 11M10 16L15 11" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function ArrowRightIcon({ color = '#000000' }: { color?: string }) {
  return (
    <Svg width={12} height={12} viewBox="0 0 12 12" fill="none">
      <Path d="M4.5 2.5L8 6L4.5 9.5" stroke={color} strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function FilterChevronIcon({ color = '#202224' }: { color?: string }) {
  return (
    <Svg width={20} height={20} viewBox="0 0 20 20" fill="none">
      <Path d="M6 8L10 12L14 8" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function CheckmarkIcon({ color = '#00ACC4' }: { color?: string }) {
  return (
    <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <Path d="M6.5 11.5L3 8L3.7 7.3L6.5 10.1L12.3 4.3L13 5L6.5 11.5Z" fill={color} />
    </Svg>
  );
}

export function PendingIcon({ color = '#F4B740' }: { color?: string }) {
  return (
    <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <Circle cx={8} cy={8} r={7} stroke={color} strokeWidth={1.5} fill="none" />
      <Path d="M8 4V8.5L10.5 10" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function FailedIcon({ color = '#BA6B5D' }: { color?: string }) {
  return (
    <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <Circle cx={8} cy={8} r={7} stroke={color} strokeWidth={1.5} fill="none" />
      <Path d="M5.5 5.5L10.5 10.5M10.5 5.5L5.5 10.5" stroke={color} strokeWidth={1.5} strokeLinecap="round" />
    </Svg>
  );
}

export function ExitIcon({ color = '#BA6B5D' }: { color?: string }) {
  return (
    <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <Path d="M10 2H13V14H10M6 5L3 8L6 11M3 8H11" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

// Keyed by the uppercase token symbol — callers look up `pool.name` /
// `token.symbol` verbatim (pool-page-content.tsx, yield-positions-card.tsx).
export const TOKEN_ICONS: Record<string, TokenIconComponent> = {
  ...TOKEN_MARKS,
  ETH: EthTokenIcon,
  USDC: UsdcTokenIcon,
  USDG: UsdgIcon,
  BNB: BnbTokenIcon,
  CBTC: CbtcTokenIcon,
  ETC: EtcTokenIcon,
  USDT: UsdtTokenIcon,
  DAI: DaiTokenIcon,
  WETH: WethTokenIcon,
  SUI: SuiTokenMark,
};

/**
 * The artwork for a symbol, with a yield share wearing its UNDERLYING's mark:
 * ppUSDC is USDC held a certain way, not a different coin. Every site that
 * used to do `TOKEN_ICONS[symbol] || EthTokenIcon` showed the ETH glyph for a
 * share, because "ppUSDC" is not a key (Pat, 2026-09-05, My balances). Falls
 * back to the ETH mark for a genuinely unknown symbol, as before.
 */
export function tokenIconFor(symbol: string | undefined | null): TokenIconComponent {
  return TOKEN_ICONS[tokenIconKey(symbol)] ?? EthTokenIcon;
}

/**
 * The TOKEN_ICONS key for a symbol (a share resolves to its underlying). For
 * render sites: `TOKEN_ICONS[tokenIconKey(s)] ?? EthTokenIcon` reads to the
 * React Compiler lint as a lookup, where a component-returning call in the
 * render body is flagged as creating a component during render.
 */
export function tokenIconKey(symbol: string | undefined | null): string {
  return displayTokenSymbol(symbol ?? '').toUpperCase();
}

export type PoolOption = {
  id: string;
  name: string;
  tvl: string;
  icon: TokenIconComponent;
  /** Chain the pool lives on; the header routes to /chains/<chainKey>/<name>. */
  chainId: number;
  /** Lowercase chain name, the CHAIN_OPTIONS selector id. */
  chainKey: string;
};

export type TxRow = {
  asset: string;
  icon: TokenIconComponent;
  date: string;
  value: string;
  status: 'completed' | 'pending' | 'failed';
  txHash: string;
  chainId: number;
  source: Transaction;
};

export type PoolAccount = {
  name: string;
  icon: TokenIconComponent;
  chainId: number;
  balance: string;
  pendingValue: string;
  ethBalance: string;
  scoreColor: string;
  filledDots: number;
  total: string;
};

export { DaiTokenIcon, EtcTokenIcon } from '@/components/ui/token-icons';

export const SCORE_COLORS = ['#BA6B5D', '#F4B740', '#00ACC4'];

export function getResponsiveFontSize(width: number): number {
  if (width >= 785) return 24;
  if (width >= 700) return 21;
  if (width >= 620) return 18;
  if (width >= 540) return 16;
  return 14;
}

export function UsdcTokenIcon({ size = 20 }: { size?: number }) { return <SharedUsdcTokenIcon size={size} />; }
export function UsdtTokenIcon({ size = 20 }: { size?: number }) { return <SharedUsdtTokenIcon size={size} />; }
