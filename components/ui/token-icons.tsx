// Token marks for ETH, USDC and USDT.
//
// The transfer and payment-request modals drew these identically. Moved verbatim
// from components/transfer-modal-provider.tsx; sizes stay a prop, defaults
// unchanged, so callers render exactly what they rendered before.
//
// The symbol → icon MAP deliberately stayed with each modal: the transfer one also
// keys a Sui mark that lives there, and the payment-request one is a different
// shape. Only the three glyphs are shared.
import Svg, { Circle, Path } from 'react-native-svg';

// nw-keep(svg-or-canvas): token-glyph SVG fills are fixed brand colors baked
// into the vector paths (theme-independent); Svg/Path/Circle fill props have no
// className path (width/height are react-native-svg props, not style).

export function EthTokenIcon({ size = 16 }: { size?: number }) {
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

export function UsdcTokenIcon({ size = 16 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <Circle cx={16} cy={16} r={16} fill="#3E73C4" />
      <Path d="M20.022 18.124c0-2.124-1.28-2.852-3.84-3.156-1.828-.243-2.193-.728-2.193-1.578 0-.85.61-1.396 1.828-1.396 1.097 0 1.707.364 2.011 1.275a.458.458 0 00.427.303h.975a.416.416 0 00.427-.425v-.06a3.04 3.04 0 00-2.743-2.489V9.142c0-.243-.183-.425-.487-.486h-.915c-.243 0-.426.182-.487.486v1.396c-1.829.242-2.986 1.456-2.986 2.974 0 2.002 1.218 2.791 3.778 3.095 1.707.303 2.255.668 2.255 1.639 0 .97-.853 1.638-2.011 1.638-1.585 0-2.133-.667-2.316-1.578-.06-.242-.244-.364-.427-.364h-1.036a.416.416 0 00-.426.425v.06c.243 1.518 1.219 2.61 3.23 2.914v1.457c0 .242.183.425.487.485h.915c.243 0 .426-.182.487-.485V21.34c1.829-.303 3.047-1.578 3.047-3.217z" fill="#FFF" />
      <Path d="M12.892 24.497c-4.754-1.7-7.192-6.98-5.424-11.653.914-2.55 2.925-4.491 5.424-5.402.244-.121.365-.303.365-.607v-.85c0-.242-.121-.424-.365-.485-.061 0-.183 0-.244.06a10.895 10.895 0 00-7.13 13.717c1.096 3.4 3.717 6.01 7.13 7.102.244.121.488 0 .548-.243.061-.06.061-.122.061-.243v-.85c0-.182-.182-.424-.365-.546zm6.46-18.936c-.244-.122-.488 0-.548.242-.061.061-.061.122-.061.243v.85c0 .243.182.485.365.607 4.754 1.7 7.192 6.98 5.424 11.653-.914 2.55-2.925 4.491-5.424 5.402-.244.121-.365.303-.365.607v.85c0 .242.121.424.365.485.061 0 .183 0 .244-.06a10.895 10.895 0 007.13-13.717c-1.096-3.46-3.778-6.07-7.13-7.162z" fill="#FFF" />
    </Svg>
  );
}

export function UsdtTokenIcon({ size = 16 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <Circle cx={10} cy={10} r={10} fill="#26A17B" />
      <Path d="M11 9.25V7.75H14V5.75H6V7.75H9V9.25C7 9.4 5.5 9.9 5.5 10.5C5.5 11.1 7 11.6 9 11.75V15H11V11.75C13 11.6 14.5 11.1 14.5 10.5C14.5 9.9 13 9.4 11 9.25ZM10 11C7.8 11 6 10.6 6 10.1C6 9.6 7.8 9.2 10 9.2C12.2 9.2 14 9.6 14 10.1C14 10.6 12.2 11 10 11Z" fill="white" />
    </Svg>
  );
}

