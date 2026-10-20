import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Platform, Text } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { useToast } from '@/components/toast-provider';

/**
 * Small inline copy control for truncated addresses: tap to copy the FULL
 * value, flashes a check for a moment. Implemented as a nested <Text> (not a
 * Pressable) so it can sit inline INSIDE other Text runs — "Deposit to:
 * 0x12…34 ⧉ (account key)" — as well as in ordinary rows; RN allows onPress
 * on nested Text on every platform.
 */
export function CopyIconButton({
  value,
  size = 12,
  color,
  label = 'Address',
  leading = '  ',
}: {
  /** The full (untruncated) string to copy. */
  value: string;
  size?: number;
  /** Icon color; defaults to the secondary text token. */
  color?: string;
  /** What was copied, for the toast — "Address copied". */
  label?: string;
  /** Space before the icon; inline meta lines pass one so the gap matches their " · " separators. */
  leading?: string;
}) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const copy = useCallback(async (e?: { stopPropagation?: () => void }) => {
    // Many hosts are themselves pressable (header account chip, table rows) —
    // copying must not also trigger the parent press.
    e?.stopPropagation?.();
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(value);
      } else {
        const Clipboard = await import('expo-clipboard');
        await Clipboard.setStringAsync(value);
      }
      setCopied(true);
      toast({ title: `${label} copied` });
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (permissions/insecure context) — stay quiet.
    }
  }, [value, label, toast]);

  // The space sits in a plain outer Text, not in the pressable: on web the
  // pressable is an inline-block <button>, where a leading space collapses
  // and left the icon touching the address. A Text (not a fragment) keeps the
  // space legal for callers that place this directly in a View.
  // nw-keep(measured-or-inset): line height tracks the caller's glyph size, so
  // the icon never stretches the host line.
  const lineHeight = { lineHeight: size + 2 };
  return (
    <Text style={lineHeight}>
      {leading}
      <Text
        onPress={copy}
        accessibilityRole="button"
        accessibilityLabel={copied ? 'Copied' : 'Copy address'}
        // nw-keep(measured-or-inset): see the outer Text.
        style={lineHeight}
      >
        <Ionicons
          name={copied ? 'checkmark' : 'copy-outline'}
          size={size}
          color={copied ? colors.success : (color ?? colors.textSecondary)}
        />
      </Text>
    </Text>
  );
}

/**
 * A truncated address in a transaction row: pressing the address opens the
 * chain explorer's address page (new tab on web); the copy icon follows it
 * on every device.
 * Nested-Text based like CopyIconButton, so it sits inline in meta lines.
 */
export function AddressWithExplorer({
  display,
  full,
  href,
  size = 12,
}: {
  /** Truncated display text (0x12…34 or an ENS name). */
  display: string;
  /** Full value the copy control copies. */
  full: string;
  /** Explorer address URL for the row's chain. */
  href: string;
  size?: number;
}) {
  const [hovered, setHovered] = useState(false);
  const hoverProps = Platform.OS === 'web'
    ? ({ onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) } as object)
    : null;
  return (
    <Text {...hoverProps}>
      <Text
        accessibilityRole="link"
        onPress={(e?: { stopPropagation?: () => void }) => {
          e?.stopPropagation?.();
          Linking.openURL(href);
        }}
        // nw-keep(platform-css): underline on hover is the web link affordance
        style={Platform.OS === 'web' && hovered ? ({ textDecorationLine: 'underline' } as object) : undefined}
      >
        {display}
      </Text>
      {/* Always shown: a hidden icon still held its space, which left an
          uneven gap before the row's next " · " separator. */}
      <CopyIconButton value={full} size={size} leading=" " />
    </Text>
  );
}
