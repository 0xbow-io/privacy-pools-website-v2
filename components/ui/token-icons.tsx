// Shared token artwork for selectors, pool details, and transaction surfaces.
import { Image, View } from 'react-native';
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

/** Current blue USDC symbol from https://www.usdc.com/ (2026-10-22).
 * Source: https://cdn.prod.website-files.com/66327d2c71b7019a2a9a1b62/67f7d439a39e389dc9758ed0_USDC-256x256.png
 */
export function UsdcTokenIcon({ size = 16 }: { size?: number }) {
  return (
    <Image source={require('@/assets/images/tokens/usdc.png')} resizeMode="contain"
      accessibilityIgnoresInvertColors
      // nw-keep(svg-or-canvas): prop-driven dimensions preserve the official artwork.
      style={{ width: size, height: size }} />
  );
}

/** Circular display artwork from https://tether.to/en/media/ (2026-10-22). */
export function UsdtTokenIcon({ size = 16 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 800 800" fill="none">
      <Circle cx={400} cy={400} r={400} fill="#009393" />
      <Path d="M400.49,428.59c68.79,0,126.28-11.63,140.33-27.17-11.93-13.18-55.08-23.56-109.88-26.4v32.83c-9.81.51-20.01.76-30.46.76s-20.65-.25-30.48-.76v-32.83c-54.78,2.84-97.95,13.22-109.88,26.4,14.07,15.54,71.57,27.17,140.36,27.17ZM522.71,274.06v45.21h-91.77v31.35c64.46,3.35,112.83,17.13,113.19,33.62v34.38c-.36,16.49-48.73,30.24-113.19,33.6v76.94h-60.93v-76.94c-64.46-3.35-112.81-17.11-113.17-33.6v-34.38c.36-16.49,48.71-30.27,113.17-33.62v-31.35h-91.77v-45.21h244.48ZM242.15,202.11h322.16c7.7,0,14.79,4.05,18.63,10.63l93.85,161.16c4.86,8.36,3.42,18.91-3.52,25.68l-258.34,252.18c-8.38,8.17-21.84,8.17-30.2,0L126.71,399.92c-7.09-6.94-8.43-17.79-3.2-26.19l100.33-161.49c3.91-6.28,10.85-10.12,18.32-10.12Z" fill="#FFF" fillRule="evenodd" />
    </Svg>
  );
}

/** Official USDG token logo: https://globaldollar.com/brand
 * Source: https://framerusercontent.com/images/CtEQkwH2xKYB2x8WTHX8Zja9d4.png
 */
export function UsdgIcon({ size = 20 }: { size?: number }) {
  return (
    <View className="items-center justify-center rounded-full"
      // nw-keep(data-color): background sampled from the official USDG artwork.
      // nw-keep(svg-or-canvas): preserve the circle size while giving the inner mark breathing room.
      style={{ width: size, height: size, backgroundColor: '#314012' }}>
      <Image
        source={require('@/assets/images/tokens/usdg.png')}
        accessibilityIgnoresInvertColors
        resizeMode="contain"
        // nw-keep(svg-or-canvas): proportional inset preserves the official artwork.
        style={{ width: size * 0.86, height: size * 0.86 }}
      />
    </View>
  );
}

/** Official cBTC.svg from Citrea's brand kit, distinct from the chain icon.
 * https://drive.google.com/file/d/1hGjZMSQRAweNtAIVLCZ69mLgl27P663w/view
 */
export function CbtcTokenIcon({ size = 20 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 1366 1366" fill="none">
      <Path d="M1345.5,848.2c-91.2,365.9-461.9,588.6-827.8,497.4C151.9,1254.4-70.8,883.7,20.4,517.8,111.6,151.8,482.2-70.9,848.1,20.3c366,91.2,588.6,461.9,497.4,827.9h0Z" fill="#F7931A" />
      <Path d="M925.1,555.2h0c13.6-90.8-55.6-139.7-150.2-172.3l30.7-123.1-75-18.7-29.9,119.9c-19.7-4.9-39.9-9.5-60.1-14.1l30.1-120.7-74.9-18.7-30.7,123.1c-16.3-3.7-151.1-37.4-151.1-37.4l-19.9,80.1s55.6,12.7,54.4,13.5c30.4,7.6,35.8,27.7,34.9,43.6l-84.1,337.3c-3.7,9.2-13.1,23.1-34.3,17.8.8,1.1-54.5-13.6-54.5-13.6l-37.2,85.8s133.5,33.6,151,38.1l-31,124.5,74.9,18.7,30.7-123.2c20.5,5.6,40.3,10.7,59.7,15.5l-30.6,122.6,75,18.7,31-124.3c27.7,5.2,53.8,8.9,78.3,10.2l67.4-116.8h120.5c29.4-89.8-4.8-142.1-70.7-176.4,49-11.3,85.9-43.5,95.7-110.1h0ZM753.8,795.3c-23.2,93.1-179.9,42.8-230.7,30.1l41.2-165c50.8,12.7,213.7,37.8,189.5,134.9h0ZM777,553.8c-21.1,84.7-151.6,41.7-193.9,31.1l37.3-149.6c42.3,10.5,178.6,30.2,156.6,118.5h0Z" fill="#FFFFFF" />
      <Path d="M1043.1,999.6h-110.8c-7.4,0-14-3.8-17.2-9.8v-.2c-3.8-6.2-3.8-13.9,0-20.2l55.1-96.4,72.9,126.5h0Z" fill="#FFFFFF" />
      <Path d="M914.6,1032.5c3.7-6.2,10.3-10,17.3-10h111.3l-72.9,126.6-55.6-96.4h0c-3.7-6.2-3.7-14,0-20.2h0Z" fill="#FFFFFF" />
      <Path d="M950.5,861.5l-55.6,96.4c-3.7,6.2-10.3,10-17.3,10s-14-3.8-17.2-9.8l-56.1-96.5h146.2,0Z" fill="#FFFFFF" />
      <Path d="M804.2,1160.5l55.6-96.4c3.7-6.2,10.3-10,17.3-10s14.1,4,17.2,9.8l55.7,96.5h-145.8Z" fill="#FFFFFF" />
      <Path d="M840.3,989.6c-3.7,6.2-10.3,10-17.3,10h-111.3l72.9-126.6,55.7,96.5c3.7,6.2,3.7,13.9,0,20.1h0Z" fill="#FFFFFF" />
      <Path d="M823,1022.5c7.4,0,14,3.8,17.2,9.8v.2c3.8,6.2,3.8,13.9,0,20.2l-55.6,96.4-72.9-126.6h111.3Z" fill="#FFFFFF" />
    </Svg>
  );
}

export function DaiTokenIcon({ size = 20 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <Circle cx={10} cy={10} r={10} fill="#F5AC37" />
      <Path d="M6 10H14M6 8H14M10 4L6 10L10 16L14 10L10 4Z" stroke="white" strokeWidth={1} />
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
