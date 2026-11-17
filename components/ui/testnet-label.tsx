import { Text } from 'react-native';

/** Shared treatment for the app environment and chain-icon markers. */
export function TestnetLabel({ compact = false, size = 24, label = compact ? 'TEST' : 'TESTNET' }: { compact?: boolean; size?: number; label?: string }) {
  return (
    <Text
      accessibilityLabel={label === 'STAGING' ? 'Staging' : 'Testnet'}
      className={`shrink-0 overflow-hidden rounded-pill bg-[#FFF1BB] text-center font-pp-bold text-[#8A6500] dark:bg-[#F2C94C] dark:text-[#161616] ${compact ? 'px-[3px]' : 'px-[5px] tracking-[0.2px]'}`}
      // nw-keep(svg-or-canvas): scale the compact label with its chain icon.
      style={{ fontSize: compact ? Math.max(6, size * 0.25) : 8, lineHeight: compact ? Math.max(10, size * 0.5) : 13 }}
    >
      {label}
    </Text>
  );
}
