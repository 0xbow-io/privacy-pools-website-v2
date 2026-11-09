import { Platform, View } from 'react-native';
import { Skeleton } from '@/components/ui/skeleton';
import { splitLoadingFigures } from '@/services/token-format';

/** The fields of a balance view (services/share-balance-display.ts) a figure needs. */
type FigureView = { text: string; symbol: string; loading?: boolean };

// Inline on web so the shimmer sits in the line of text it replaces a number in.
// nw-keep(platform-css): inline-flex has no className path inside a nested Text.
const INLINE = Platform.OS === 'web' ? ({ display: 'inline-flex', verticalAlign: 'middle' } as object) : undefined;

function Shimmer({ testID }: { testID?: string }) {
  return (
    <View style={INLINE} testID={testID ?? 'share-figure-loading'} accessibilityLabel="Amount loading">
      <Skeleton width={40} height={10} radius={5} />
    </View>
  );
}

/**
 * An amount figure from a balance view, for use inside a <Text>. While the
 * rate is loading the number is a shimmer (the Portfolio skeleton), followed
 * by the coin ("USDC"). Once the rate arrives it is the converted underlying.
 * Never a stand-in count.
 */
export function ShareFigure({ view, testID }: { view: FigureView; testID?: string }) {
  if (!view.loading) return <>{view.text}</>;
  return (
    <>
      <Shimmer testID={testID} />
      {` ${view.symbol}`}
    </>
  );
}

/**
 * Display text that may hold a loading figure ("… USDC", LOADING_FIGURE), for
 * use inside a <Text>: every loading figure becomes the shimmer, the rest of
 * the text is kept as it is (splitLoadingFigures).
 */
export function FigureText({ text, testID }: { text: string | null | undefined; testID?: string }) {
  if (!text) return null;
  const parts = splitLoadingFigures(text);
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) => (
        <FigurePart key={i} part={part} shimmer={i > 0} testID={testID} />
      ))}
    </>
  );
}

function FigurePart({ part, shimmer, testID }: { part: string; shimmer: boolean; testID?: string }) {
  return (
    <>
      {shimmer ? <Shimmer testID={testID} /> : null}
      {part}
    </>
  );
}
