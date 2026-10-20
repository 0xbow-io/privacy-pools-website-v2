import Animated from 'react-native-reanimated';

export function HelloWave() {
  return (
    <Animated.Text
      className="-mt-[6px] text-[28px] leading-[32px]"
      // nw-keep(animated): Reanimated CSS-animation keyframes drive the wave rotation — genuinely animated properties
      style={{
        animationName: {
          '50%': { transform: [{ rotate: '25deg' }] },
        },
        animationIterationCount: 4,
        animationDuration: '300ms',
      }}>
      👋
    </Animated.Text>
  );
}
