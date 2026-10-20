// The icon set the modal providers share.
//
// Each of these was defined byte-identically in up to seven components. Only the
// variants that were genuinely identical moved here: where a file drew its own
// version (the transfer modal's carets, for instance), that file keeps it, since
// consolidating a near-copy would silently change what is on screen.
//
// Sizes are baked in rather than props because every caller used the same one;
// add a prop the day a caller genuinely needs a different size.
import Svg, { Circle, Path } from 'react-native-svg';

/** 16px cross for modal dismiss buttons. */
export function CloseIcon({ color = '#000000' }: { color?: string }) {
  return (
    // nw-keep(svg-or-canvas): stroke fed by the caller's color prop (close glyph)
    <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <Path d="M12.5 3.5L3.5 12.5M3.5 3.5L12.5 12.5" stroke={color} strokeWidth={1.5} strokeLinecap="round" />
    </Svg>
  );
}

/** 16px circled "i" for inline explanations. */
export function ModalInfoIcon({ color = '#4D4D4D' }: { color?: string }) {
  return (
    <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <Path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5ZM2.5 8C2.5 4.96243 4.96243 2.5 8 2.5C11.0376 2.5 13.5 4.96243 13.5 8C13.5 11.0376 11.0376 13.5 8 13.5C4.96243 13.5 2.5 11.0376 2.5 8ZM8 4C7.58579 4 7.25 4.33579 7.25 4.75C7.25 5.16421 7.58579 5.5 8 5.5C8.41421 5.5 8.75 5.16421 8.75 4.75C8.75 4.33579 8.41421 4 8 4ZM8.75 11V7H6.75V8H7.75V11H6.5V12H9.5V11H8.75Z"
        fill={color}
      />
    </Svg>
  );
}

/** 16px solid caret, collapsed state. */
export function CaretDownIcon({ color = '#000000' }: { color?: string }) {
  return (
    <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <Path d="M12 6L8 11L4 6H12Z" fill={color} />
    </Svg>
  );
}

/** 16px solid caret, expanded state. */
export function CaretUpIcon({ color = '#000000' }: { color?: string }) {
  return (
    <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <Path d="M4 10L8 5L12 10H4Z" fill={color} />
    </Svg>
  );
}

/**
 * 40px three-quarter arc. Static on its own — callers animate it, so it carries
 * no rotation of its own.
 */
export function SpinnerIcon({ color = '#000000' }: { color?: string }) {
  return (
    <Svg width={40} height={40} viewBox="0 0 40 40" fill="none">
      <Path
        d="M20 4C11.16 4 4 11.16 4 20C4 28.84 11.16 36 20 36C28.84 36 36 28.84 36 20"
        stroke={color}
        strokeWidth={3}
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  );
}

/** 48px success mark for the settled state of a flow. */
export function CheckCircleIcon({ color = '#00ACC4' }: { color?: string }) {
  return (
    // nw-keep(svg-or-canvas): stroke fed by the caller's color prop (success mark)
    <Svg width={48} height={48} viewBox="0 0 48 48" fill="none">
      <Circle cx={24} cy={24} r={23} stroke={color} strokeWidth={2} fill="none" />
      <Path d="M15 24L21 30L33 18" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}

/** 48px attention mark for a settled flow that did not do what was asked. */
export function AlertCircleIcon({ color = '#E8A33D' }: { color?: string }) {
  return (
    // nw-keep(svg-or-canvas): stroke fed by the caller's color prop (attention mark)
    <Svg width={48} height={48} viewBox="0 0 48 48" fill="none">
      <Circle cx={24} cy={24} r={23} stroke={color} strokeWidth={2} fill="none" />
      <Path d="M24 14V27" stroke={color} strokeWidth={2.5} strokeLinecap="round" fill="none" />
      <Circle cx={24} cy={33} r={1.6} fill={color} />
    </Svg>
  );
}
