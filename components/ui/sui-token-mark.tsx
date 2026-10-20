import { View } from 'react-native';
import { SuiIcon } from './sui-icon';

/**
 * SUI token logo: white droplet on the brand-blue circle — same shape as the
 * other token marks (ETH/USDC/USDT) so it drops into POOL_ICONS / TOKEN_MARKS.
 */
export function SuiTokenMark({ size = 20 }: { size?: number }) {
  return (
    <View
      className="items-center justify-center bg-[#4DA2FF]"
      // nw-keep(svg-or-canvas): prop-driven geometry — the size prop scales the brand circle around the SVG droplet
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
      }}
    >
      <SuiIcon width={size * 0.5} height={size * 0.62} color="#FFFFFF" />
    </View>
  );
}
