import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, Text, View, useWindowDimensions } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import Svg, { Defs, LinearGradient, Line, Polygon, Rect, Stop } from 'react-native-svg';

import { Logo } from '@/components/ui/logo';
import { useToast } from '@/components/toast-provider';

/**
 * Origami facet card, native only. Two faceted leaves fold open along the
 * card's outer edges in 3D and uncover the card details underneath. It stays
 * folded after the entrance; each tap folds or unfolds it.
 */

// Preview details until real cards are issued.
const CARD = {
  holder: 'vitalik.eth',
  pan: '4532  8921  7409  6183',
  panClean: '4532892174096183',
  last4: '6183',
  exp: '09/29',
  cvv: '842',
};

// Graphite body with the theme's bronze accent (mono studio `accent`).
const INK = '#141414';
const GRAPHITE = '#262626';
const GRAPHITE_LIGHT = '#3A3A3A';
const BRONZE_SOFT = 'rgba(184, 166, 134, 0.35)';

const ASPECT = 1.586;

export function OrigamiCard() {
  const { width: screenWidth } = useWindowDimensions();
  const width = Math.min(screenWidth - 48, 360);
  const height = width / ASPECT;
  const half = width / 2;
  const { toast } = useToast();

  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<'pan' | 'cvv' | null>(null);
  const enter = useRef(new Animated.Value(0)).current;
  const fold = useRef(new Animated.Value(0)).current;
  const reveal = useRef(new Animated.Value(0)).current;
  const sweep = useRef(new Animated.Value(0)).current;
  const float = useRef(new Animated.Value(0)).current;

  const runFold = useCallback(
    (toOpen: boolean) => {
      Haptics.impactAsync(toOpen ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      Animated.spring(fold, { toValue: toOpen ? 1 : 0, damping: 14, stiffness: 90, mass: 1, useNativeDriver: true }).start();
      Animated.timing(reveal, {
        toValue: toOpen ? 1 : 0,
        duration: toOpen ? 520 : 180,
        delay: toOpen ? 220 : 0,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
      if (toOpen) {
        sweep.setValue(0);
        Animated.timing(sweep, { toValue: 1, duration: 1100, delay: 300, easing: Easing.inOut(Easing.cubic), useNativeDriver: true }).start();
      }
    },
    [fold, reveal, sweep],
  );

  useEffect(() => {
    Animated.timing(enter, { toValue: 1, duration: 700, easing: Easing.out(Easing.back(1.4)), useNativeDriver: true }).start();
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(float, { toValue: 1, duration: 2600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(float, { toValue: 0, duration: 2600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [enter, float]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    runFold(next);
  };

  const copy = async (value: string, which: 'pan' | 'cvv') => {
    await Clipboard.setStringAsync(value);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    setCopied(which);
    toast({ title: which === 'pan' ? 'Card number copied.' : 'CVV copied.' });
    setTimeout(() => setCopied((c) => (c === which ? null : c)), 2000);
  };

  const leftRotate = fold.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '-112deg'] });
  const rightRotate = fold.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '112deg'] });
  const leafShade = fold.interpolate({ inputRange: [0, 1], outputRange: [0, 0.55] });
  const coreGlow = fold.interpolate({ inputRange: [0, 1], outputRange: [0.2, 1] });
  const coreScale = fold.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] });
  const revealY = reveal.interpolate({ inputRange: [0, 1], outputRange: [8, 0] });
  const sweepX = sweep.interpolate({ inputRange: [0, 1], outputRange: [-width, width] });
  const sweepOpacity = sweep.interpolate({ inputRange: [0, 0.15, 0.85, 1], outputRange: [0, 0.9, 0.9, 0] });

  const enterScale = enter.interpolate({ inputRange: [0, 1], outputRange: [0.82, 1] });
  const enterTilt = enter.interpolate({ inputRange: [0, 1], outputRange: ['24deg', '0deg'] });
  const floatY = float.interpolate({ inputRange: [0, 1], outputRange: [0, -8] });
  const floatTilt = float.interpolate({ inputRange: [0, 1], outputRange: ['-3deg', '3deg'] });

  const chipW = height * 0.24;

  return (
    <Pressable onPress={toggle} accessibilityRole="button" accessibilityLabel={open ? 'Hide card details' : 'Reveal card details'} testID="card-origami">
      <Animated.View
        // nw-keep(animated): entrance, float and tilt are Animated transforms
        style={{
          width,
          height,
          opacity: enter,
          transform: [{ perspective: 1200 }, { translateY: floatY }, { rotateX: enterTilt }, { rotateY: floatTilt }, { scale: enterScale }],
        }}
      >
        {/* Core plate: the card details, uncovered when the leaves open. */}
        <Animated.View
          accessibilityElementsHidden={!open}
          importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
          className="absolute inset-0 overflow-hidden rounded-[18px] bg-[#141414]"
          // nw-keep(animated): core scale follows the fold
          style={{ transform: [{ scale: coreScale }] }}
        >
          {/* nw-keep(svg-or-canvas): full-bleed SVG backdrop sized to the measured card */}
          <Svg width={width} height={height} style={{ position: 'absolute' }}>
            <Defs>
              <LinearGradient id="core" x1="0" y1="0" x2="1" y2="1">
                <Stop offset="0" stopColor="#1E1C19" />
                <Stop offset="0.55" stopColor={INK} />
                <Stop offset="1" stopColor="#050505" />
              </LinearGradient>
            </Defs>
            <Rect width={width} height={height} fill="url(#core)" />
            <Polygon points={`0,${height} ${width * 0.42},0 ${width * 0.5},0 ${width * 0.08},${height}`} fill="rgba(255,255,255,0.03)" />
          </Svg>

          {/* Watermark logo with a bronze bloom that wakes as the card opens. */}
          <Animated.View
            className="absolute rounded-full"
            // nw-keep(animated): bronze bloom, opacity and scale follow the fold
            style={{
              width: height * 0.8,
              height: height * 0.8,
              right: -height * 0.12,
              top: height * 0.1,
              backgroundColor: BRONZE_SOFT,
              opacity: Animated.multiply(coreGlow, 0.5),
              transform: [{ scale: coreGlow }],
            }}
          />
          {/* nw-keep(measured-or-inset): watermark offsets are fractions of the measured card height */}
          <View className="absolute opacity-[0.07]" style={{ right: -height * 0.05, top: height * 0.16 }}>
            <Logo width={height * 0.68} height={height * 0.68} variant="white" />
          </View>

          <View className="flex-1 justify-between p-[18px]">
            <View className="flex-row items-center justify-between">
              <View className="flex-row items-center gap-[8px]">
                <Logo width={20} height={20} variant="white" />
                <Text numberOfLines={1} className="font-pp-sans-semi-bold text-[12px] tracking-[1.5px] text-white">{CARD.holder}</Text>
              </View>
              <View className="rotate-90"><Ionicons name="wifi" size={16} color="#B8A686" /></View>
            </View>

            <GoldChip width={chipW} />

            <Animated.View
              // nw-keep(animated): details fade and settle in once the leaves are out of the way
              style={{ opacity: reveal, transform: [{ translateY: revealY }] }}
            >
              <View className="mb-[10px] flex-row items-center justify-between">
                <Text className="font-pp-sans-semi-bold text-[17px] tracking-[2px] text-white">
                  {CARD.pan}
                </Text>
                <CopyButton copied={copied === 'pan'} label="Copy card number" onPress={() => copy(CARD.panClean, 'pan')} />
              </View>
              <View className="flex-row items-end justify-between">
                <View className="flex-row items-end gap-[14px]">
                  <View>
                    <Text className="font-pp-sans text-[8px] tracking-[1.5px] text-[#8A8A8A]">EXP</Text>
                    <Text className="font-pp-sans-semi-bold text-[12px] text-white">{CARD.exp}</Text>
                  </View>
                  <View className="flex-row items-center gap-[6px] rounded-[8px] border border-[#B8A68659] bg-[#B8A6861F] px-[8px] py-[4px]">
                    <View>
                      <Text className="font-pp-sans text-[8px] tracking-[1.5px] text-[#B8A686]">CVV</Text>
                      <Text className="font-pp-sans-bold text-[13px] text-white">{CARD.cvv}</Text>
                    </View>
                    <CopyButton copied={copied === 'cvv'} label="Copy CVV" onPress={() => copy(CARD.cvv, 'cvv')} small />
                  </View>
                </View>
                <Text className="font-pp-sans-semi-bold text-[10px] tracking-[2.5px] text-[#B8A686]">PRIVACY POOLS</Text>
              </View>
            </Animated.View>
          </View>

          <Animated.View
            pointerEvents="none"
            className="absolute bottom-0 top-0"
            // nw-keep(animated): light sweep across the details after they open
            style={{ width: width * 0.35, opacity: sweepOpacity, transform: [{ translateX: sweepX }, { skewX: '-18deg' }] }}
          >
            <Svg width="100%" height="100%">
              <Defs>
                <LinearGradient id="sweep" x1="0" y1="0" x2="1" y2="0">
                  <Stop offset="0" stopColor="#FFFFFF" stopOpacity="0" />
                  <Stop offset="0.5" stopColor="#FFFFFF" stopOpacity="0.18" />
                  <Stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
                </LinearGradient>
              </Defs>
              <Rect width="100%" height="100%" fill="url(#sweep)" />
            </Svg>
          </Animated.View>
        </Animated.View>

        {/* Left leaf, hinged on the card's left edge. */}
        <Animated.View
          pointerEvents={open ? 'none' : 'auto'}
          accessibilityElementsHidden={open}
          importantForAccessibility={open ? 'no-hide-descendants' : 'auto'}
          className="absolute bottom-0 left-0 top-0 overflow-hidden rounded-l-[18px]"
          // nw-keep(animated): leaf folds on rotateY around its outer edge
          style={{ width: half, backfaceVisibility: 'hidden', transformOrigin: 'left center', transform: [{ perspective: 1200 }, { rotateY: leftRotate }] }}
        >
          <Leaf side="left" width={half} height={height} chipW={chipW} />
          {/* nw-keep(animated): leaf darkens as it folds away */}
          <Animated.View className="absolute inset-0 bg-black" style={{ opacity: leafShade }} />
        </Animated.View>

        {/* Right leaf, hinged on the card's right edge. */}
        <Animated.View
          pointerEvents={open ? 'none' : 'auto'}
          accessibilityElementsHidden={open}
          importantForAccessibility={open ? 'no-hide-descendants' : 'auto'}
          className="absolute bottom-0 right-0 top-0 overflow-hidden rounded-r-[18px]"
          // nw-keep(animated): leaf folds on rotateY around its outer edge
          style={{ width: half, backfaceVisibility: 'hidden', transformOrigin: 'right center', transform: [{ perspective: 1200 }, { rotateY: rightRotate }] }}
        >
          <Leaf side="right" width={half} height={height} chipW={chipW} copied={copied === 'pan'} onCopy={() => copy(CARD.panClean, 'pan')} />
          {/* nw-keep(animated): leaf darkens as it folds away */}
          <Animated.View className="absolute inset-0 bg-black" style={{ opacity: leafShade }} />
        </Animated.View>
      </Animated.View>
    </Pressable>
  );
}

function CopyButton({ copied, label, onPress, small }: { copied: boolean; label: string; onPress: () => void; small?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={label}
      className={`items-center justify-center rounded-[8px] border border-[#B8A68659] bg-[#B8A6861F] active:opacity-70 ${small ? 'h-[22px] w-[22px]' : 'h-[30px] w-[30px]'}`}
    >
      {/* nw-keep(data-color): copy glyph flips to the success green once copied (vector-icon sink) */}
      <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={small ? 12 : 15} color={copied ? '#8FCFA9' : '#E8DCC4'} />
    </Pressable>
  );
}

/** Gold EMV contact chip. */
function GoldChip({ width }: { width: number }) {
  const h = width * 0.76;
  return (
    <Svg width={width} height={h} viewBox="0 0 50 38">
      <Defs>
        <LinearGradient id="gold" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#F6E3A1" />
          <Stop offset="0.45" stopColor="#D9B45A" />
          <Stop offset="1" stopColor="#A67C2E" />
        </LinearGradient>
      </Defs>
      <Rect x="0.5" y="0.5" width="49" height="37" rx="7" fill="url(#gold)" stroke="#8C6A2A" strokeWidth="0.8" />
      <Line x1="0" y1="13" x2="17" y2="13" stroke="#8C6A2A" strokeWidth="0.9" />
      <Line x1="0" y1="25" x2="17" y2="25" stroke="#8C6A2A" strokeWidth="0.9" />
      <Line x1="33" y1="13" x2="50" y2="13" stroke="#8C6A2A" strokeWidth="0.9" />
      <Line x1="33" y1="25" x2="50" y2="25" stroke="#8C6A2A" strokeWidth="0.9" />
      <Rect x="17" y="7" width="16" height="24" rx="4" fill="none" stroke="#8C6A2A" strokeWidth="0.9" />
      <Line x1="25" y1="0" x2="25" y2="7" stroke="#8C6A2A" strokeWidth="0.9" />
      <Line x1="25" y1="31" x2="25" y2="38" stroke="#8C6A2A" strokeWidth="0.9" />
    </Svg>
  );
}

/** One faceted leaf: four shaded triangles meeting at a crease point. */
function Leaf({ side, width, height, chipW, copied = false, onCopy }: { side: 'left' | 'right'; width: number; height: number; chipW: number; copied?: boolean; onCopy?: () => void }) {
  const left = side === 'left';
  const cx = left ? width * 0.62 : width * 0.38;
  const cy = height * 0.46;
  const outer = left ? 0 : width;
  const inner = left ? width : 0;
  const id = `leaf-${side}`;
  return (
    <View className="flex-1">
      <Svg width={width} height={height}>
        <Defs>
          <LinearGradient id={id} x1={left ? '0' : '1'} y1="0" x2={left ? '1' : '0'} y2="1">
            <Stop offset="0" stopColor={GRAPHITE_LIGHT} />
            <Stop offset="1" stopColor={GRAPHITE} />
          </LinearGradient>
        </Defs>
        <Rect width={width} height={height} fill={`url(#${id})`} />
        <Polygon points={`${outer},0 ${inner},0 ${cx},${cy}`} fill="rgba(255,255,255,0.07)" />
        <Polygon points={`${inner},0 ${inner},${height} ${cx},${cy}`} fill="rgba(0,0,0,0.18)" />
        <Polygon points={`${inner},${height} ${outer},${height} ${cx},${cy}`} fill="rgba(0,0,0,0.30)" />
        <Polygon points={`${outer},${height} ${outer},0 ${cx},${cy}`} fill="rgba(255,255,255,0.03)" />
        <Rect x={left ? width - 1 : 0} width={1} height={height} fill={BRONZE_SOFT} />
      </Svg>
      <View className={`absolute inset-0 justify-between p-[18px] ${left ? 'items-start' : 'items-end'}`}>
        {left ? (
          <>
            <View className="flex-row items-center gap-[8px]">
              <Logo width={20} height={20} variant="white" />
              <Text numberOfLines={1} className="shrink font-pp-sans-semi-bold text-[11px] tracking-[1.2px] text-white">{CARD.holder}</Text>
            </View>
            <GoldChip width={chipW} />
            <Text className="font-pp-sans-semi-bold text-[10px] tracking-[2.5px] text-[#B8A686]">PRIVACY POOLS</Text>
          </>
        ) : (
          <>
            <View className="flex-row items-center gap-[5px]">
              <Ionicons name="finger-print" size={12} color="#B8A686" />
              <Text className="font-pp-sans-semi-bold text-[9px] tracking-[2px] text-[#B8A686]">TAP TO REVEAL</Text>
            </View>
            <View />
            <View className="flex-row items-center gap-[8px]">
              <Text className="font-pp-sans-medium text-[14px] tracking-[3px] text-[#8A8A8A]">••••  {CARD.last4}</Text>
              {onCopy && <CopyButton copied={copied} label="Copy card number" onPress={onCopy} small />}
            </View>
          </>
        )}
      </View>
    </View>
  );
}
