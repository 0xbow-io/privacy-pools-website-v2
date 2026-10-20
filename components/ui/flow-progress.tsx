import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Text, View } from 'react-native';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';

// The four phases a deposit moves through. The provider's loading message is
// matched to one of these so the indicator advances step by step with the
// real work instead of looping an indeterminate spinner. (Pattern ported from
// feat/ui-overhaul's FlowProgress, restyled to this branch's tokens.)
const PHASES = ['Prepare', 'Prove', 'Submit', 'Confirm'] as const;

function derivePhase(message?: string): number {
  const m = (message ?? '').toLowerCase();
  // Approval rows first: "Waiting for approval confirmation..." is part of
  // submitting (an ERC-20 pre-step), not the final on-chain confirm.
  if (/approval/.test(m)) return 2;
  // Waiting on the relayer is still submitting: nothing is in a block yet
  // (DEV-494), so it must not light Confirm.
  if (/waiting for the relayer/.test(m)) return 2;
  if (/waiting for|confirm/.test(m)) return 3; // on-chain settle
  if (/submit|sign|wallet|relay/.test(m)) return 2;
  // "Preparing withdrawal proof" is still preparation, so a leading "prepar"
  // wins over the proof keyword inside it.
  if (/^prepar/.test(m)) return 0;
  if (/prov|proof|\bzk\b|merkle/.test(m)) return 1;
  return 0; // init / sync / checks
}

/**
 * Monotonic phase: derived purely from the current status message, never
 * stepping backward if messages arrive out of order, and only reaching
 * Confirm on a real confirming message. State resets with the component —
 * render FlowProgress only while the flow is in its loading step.
 */
function usePhase(message?: string): number {
  const target = derivePhase(message);
  const [maxPhase, setMaxPhase] = useState(0);
  const phase = Math.max(maxPhase, target);
  if (phase > maxPhase) setMaxPhase(phase);
  return phase;
}

/**
 * Minimal staged progress: four nodes on one connecting line. Completed and
 * active nodes fill with the ink color (a check for done, a dot for active),
 * upcoming nodes stay hollow, and a single fill eases along the track up to
 * the active node. Monochrome on purpose — it reads as part of the card, not
 * as a widget of its own.
 */
/**
 * `showMessage` exists because `message` does two jobs: it drives the phase AND
 * it is printed. A caller that renders the same string itself has to keep
 * passing it (or the phase stops advancing) while asking this not to print it.
 * The swap flow does exactly that, and without the flag the user saw
 * "Selecting notes…" twice, once here and once in the caller's own bold line
 * (QA, 2026-09-22).
 */
export function FlowProgress({ message, showMessage = true }: { message?: string; showMessage?: boolean }) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const phase = usePhase(message);
  const last = PHASES.length - 1;
  const target = last > 0 ? phase / last : 0;

  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(progress, {
      toValue: target,
      duration: 450,
      easing: Easing.bezier(0.23, 1, 0.32, 1),
      // Width interpolation has no native-driver path.
      useNativeDriver: false,
    }).start();
  }, [target, progress]);
  const fillWidth = progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  return (
    <View className="w-full gap-[14px] py-[18px]">
      <View className="relative">
        {/* One continuous track spanning the first to last node centers
            (nodes sit at 12.5/37.5/62.5/87.5% of their flex-1 columns). */}
        <View className="absolute left-[12.5%] right-[12.5%] top-[8px] h-[2px] overflow-hidden rounded-pill bg-border">
          {/* nw-keep(animated): fill width is Animated-driven */}
          <Animated.View className="h-full rounded-pill bg-text" style={{ width: fillWidth }} />
        </View>
        <View className="relative flex-row">
          {PHASES.map((label, i) => {
            const done = i < phase;
            const active = i === phase;
            const filled = done || active;
            return (
              <View key={label} className="flex-1 items-center">
                <View
                  className={`h-[18px] w-[18px] items-center justify-center rounded-full border-[2px] ${
                    filled ? 'border-text bg-text' : 'border-border bg-card-background'
                  }`}
                >
                  {done ? (
                    // nw-keep(data-color): check glyph inverts against the ink-filled node
                    <Text style={{ color: colors.cardBackground, fontSize: 10, lineHeight: 12, fontWeight: '700' }}>✓</Text>
                  ) : active ? (
                    // nw-keep(data-color): active dot inverts against the ink-filled node
                    <View className="h-[5px] w-[5px] rounded-full" style={{ backgroundColor: colors.cardBackground }} />
                  ) : null}
                </View>
              </View>
            );
          })}
        </View>
      </View>

      <View className="flex-row">
        {PHASES.map((label, i) => {
          const active = i === phase;
          const reached = i <= phase;
          return (
            <Text
              key={label}
              className={`flex-1 text-center text-[11px] ${
                active ? 'text-text font-pp-sans-semi-bold' : reached ? 'text-text-secondary font-pp-medium' : 'text-text-muted font-pp-regular'
              }`}
            >
              {label}
            </Text>
          );
        })}
      </View>

      {message && showMessage ? (
        <Text className="pt-[2px] text-center text-[13px] text-text-secondary font-pp-regular">{message}</Text>
      ) : null}
    </View>
  );
}
