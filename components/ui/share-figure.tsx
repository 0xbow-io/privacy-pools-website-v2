import { Platform, View } from 'react-native';
import { Skeleton } from '@/components/ui/skeleton';

/** The fields of a balance view (services/share-balance-display.ts) a figure needs. */
type FigureView = { text: string; symbol: string; loading?: boolean };

// Inline on web so the shimmer sits in the line of text it replaces a number in.
// nw-keep(platform-css): inline-flex has no className path inside a nested Text.
const INLINE = Platform.OS === 'web' ? ({ display: 'inline-flex', verticalAlign: 'middle' } as object) : undefined;

/**
 * An amount figure from a balance view, for use inside a <Text>. While the
 * share rate is loading the number is a shimmer (the Portfolio skeleton),
 * followed by the coin ("USDC"). Once the rate arrives it is the converted
 * underlying. Never a share count, never the word "shares".
 */
export function ShareFigure({ view, testID }: { view: FigureView; testID?: string }) {
  if (!view.loading) return <>{view.text}</>;
  return (
    <>
      <View style={INLINE} testID={testID ?? 'share-figure-loading'} accessibilityLabel="Amount loading">
        <Skeleton width={40} height={10} radius={5} />
      </View>
      {` ${view.symbol}`}
    </>
  );
}
