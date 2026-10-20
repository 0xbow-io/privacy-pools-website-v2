import { useEffect } from 'react';
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

export function UsdcTokenIcon({ size = 20 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <Circle cx={16} cy={16} r={16} fill="#3E73C4" />
      <Path d="M20.022 18.124c0-2.124-1.28-2.852-3.84-3.156-1.828-.243-2.193-.728-2.193-1.578 0-.85.61-1.396 1.828-1.396 1.097 0 1.707.364 2.011 1.275a.458.458 0 00.427.303h.975a.416.416 0 00.427-.425v-.06a3.04 3.04 0 00-2.743-2.489V9.142c0-.243-.183-.425-.487-.486h-.915c-.243 0-.426.182-.487.486v1.396c-1.829.242-2.986 1.456-2.986 2.974 0 2.002 1.218 2.791 3.778 3.095 1.707.303 2.255.668 2.255 1.639 0 .97-.853 1.638-2.011 1.638-1.585 0-2.133-.667-2.316-1.578-.06-.242-.244-.364-.427-.364h-1.036a.416.416 0 00-.426.425v.06c.243 1.518 1.219 2.61 3.23 2.914v1.457c0 .242.183.425.487.485h.915c.243 0 .426-.182.487-.485V21.34c1.829-.303 3.047-1.578 3.047-3.217z" fill="#FFF" />
      <Path d="M12.892 24.497c-4.754-1.7-7.192-6.98-5.424-11.653.914-2.55 2.925-4.491 5.424-5.402.244-.121.365-.303.365-.607v-.85c0-.242-.121-.424-.365-.485-.061 0-.183 0-.244.06a10.895 10.895 0 00-7.13 13.717c1.096 3.4 3.717 6.01 7.13 7.102.244.121.488 0 .548-.243.061-.06.061-.122.061-.243v-.85c0-.182-.182-.424-.365-.546zm6.46-18.936c-.244-.122-.488 0-.548.242-.061.061-.061.122-.061.243v.85c0 .243.182.485.365.607 4.754 1.7 7.192 6.98 5.424 11.653-.914 2.55-2.925 4.491-5.424 5.402-.244.121-.365.303-.365.607v.85c0 .242.121.424.365.485.061 0 .183 0 .244-.06a10.895 10.895 0 007.13-13.717c-1.096-3.46-3.778-6.07-7.13-7.162z" fill="#FFF" />
    </Svg>
  );
}

export function UsdtTokenIcon({ size = 20 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <Circle cx={10} cy={10} r={10} fill="#26A17B" />
      <Path d="M11 9.25V7.75H14V5.75H6V7.75H9V9.25C7 9.4 5.5 9.9 5.5 10.5C5.5 11.1 7 11.6 9 11.75V15H11V11.75C13 11.6 14.5 11.1 14.5 10.5C14.5 9.9 13 9.4 11 9.25ZM10 11C7.8 11 6 10.6 6 10.1C6 9.6 7.8 9.2 10 9.2C12.2 9.2 14 9.6 14 10.1C14 10.6 12.2 11 10 11Z" fill="white" />
    </Svg>
  );
}

// DAI + WETH deliberately reuse the artwork already shipped by the row-level
// POOL_ICONS maps (my-privacy-pools.tsx / all-pools.tsx) so the same asset can
// never render two different marks across the app. Both are saturated brand
// discs with a white glyph, exactly like ETH/USDC/USDT above — they read on
// light and dark without a theme branch.
export function DaiTokenIcon({ size = 20 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <Circle cx={10} cy={10} r={10} fill="#F5AC37" />
      <Path d="M6 10H14M6 8H14M10 4L6 10L10 16L14 10L10 4Z" stroke="white" strokeWidth={1} />
    </Svg>
  );
}

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

// Official BNB logo, matching the v1 website's src/assets/icons/bnb.svg.
export function BnbTokenIcon({ size = 20 }: { size?: number }) {
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

export function EtcTokenIcon({ size = 20 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <Circle cx={10} cy={10} r={10} fill="#3AB83A" />
      <Path d="M10 4L10 8.5L13.5 10L10 4Z" fill="rgba(255,255,255,0.6)" />
      <Path d="M10 4L6.5 10L10 8.5L10 4Z" fill="white" />
      <Path d="M10 12.5L10 16L13.5 10.75L10 12.5Z" fill="rgba(255,255,255,0.6)" />
      <Path d="M10 16L10 12.5L6.5 10.75L10 16Z" fill="white" />
      <Path d="M10 11.75L13.5 10L10 8.5L10 11.75Z" fill="rgba(255,255,255,0.4)" />
      <Path d="M6.5 10L10 11.75L10 8.5L6.5 10Z" fill="rgba(255,255,255,0.6)" />
    </Svg>
  );
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
  ETH: EthTokenIcon,
  USDC: UsdcTokenIcon,
  BNB: BnbTokenIcon,
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
  chainIcon: TokenIconComponent;
  balance: string;
  pendingValue: string;
  ethBalance: string;
  scoreColor: string;
  filledDots: number;
  total: string;
};

export const SCORE_COLORS = ['#BA6B5D', '#F4B740', '#00ACC4'];

export function getResponsiveFontSize(width: number): number {
  if (width >= 785) return 24;
  if (width >= 700) return 21;
  if (width >= 620) return 18;
  if (width >= 540) return 16;
  return 14;
}
