import { Pressable, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { shortAddress } from '@/services/address-book-core';
import type { RecipientSuggestion } from '@/services/recipient-suggestions';

export const EMPTY_TITLE = 'No saved addresses yet';
export const EMPTY_HINT = 'Paste an address. It is remembered after you withdraw or send to it.';

export type AddressSuggestionsListProps = {
  open: boolean;
  /** Focused with nothing to suggest: show the empty state instead of nothing. */
  empty?: boolean;
  /** Web only: the DOM node the list anchors to. */
  anchor: unknown;
  listId: string;
  suggestions: RecipientSuggestion[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (s: RecipientSuggestion) => void;
  onEdit: (s: RecipientSuggestion) => void;
  onClose: () => void;
  testID?: string;
};

/**
 * Native: the list opens IN FLOW under the field (no overlay). A floating
 * layer over a ScrollView either clips or eats the first tap that dismisses
 * the keyboard, and rows here are big enough to hit with a thumb.
 */
export function AddressSuggestionsList({ open, empty, suggestions, onSelect, onEdit, onClose, testID }: AddressSuggestionsListProps) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  if (empty) {
    return (
      <Pressable onPress={onClose} className="mt-[6px] flex-row items-center gap-[10px] rounded-[14px] border border-border-light bg-menu-background px-[12px] py-[10px]" accessibilityRole="text" testID={testID ? `${testID}-empty` : undefined}>
        <View className="h-[30px] w-[30px] items-center justify-center rounded-full bg-background-secondary">
          {/* nw-keep(data-color): glyph is the muted text token (vector-icon sink) */}
          <Ionicons name="people-outline" size={14} color={colors.textMuted} />
        </View>
        <View className="min-w-0 flex-1">
          <Text className="font-pp-sans-medium text-[13px] text-text">{EMPTY_TITLE}</Text>
          <Text className="font-pp-regular text-[11.5px] leading-[16px] text-text-muted">{EMPTY_HINT}</Text>
        </View>
      </Pressable>
    );
  }
  if (!open || suggestions.length === 0) return null;
  return (
    <View className="mt-[6px] overflow-hidden rounded-[14px] border border-border-light bg-menu-background" testID={testID ? `${testID}-suggestions` : undefined}>
      {suggestions.slice(0, 5).map((s, i) => (
        <View key={s.key} className={`flex-row items-center ${i > 0 ? 'border-t border-border-light' : ''}`}>
          <Pressable
            onPress={() => onSelect(s)}
            className="min-h-[52px] flex-1 flex-row items-center gap-[10px] px-[12px] py-[8px] active:bg-background-secondary"
            accessibilityRole="button"
            accessibilityLabel={s.name ? `${s.name}, ${s.address}` : s.address}
            testID={testID ? `${testID}-suggestion-${i}` : undefined}
          >
            <View className="h-[30px] w-[30px] items-center justify-center rounded-full bg-primary-soft">
              {s.name ? (
                <Text className="font-pp-sans-semi-bold text-[12px] text-primary">{Array.from(s.name)[0]!.toUpperCase()}</Text>
              ) : (
                // nw-keep(data-color): glyph is the primary theme token (vector-icon sink)
                <Ionicons name="person-outline" size={14} color={colors.primary} />
              )}
            </View>
            <View className="min-w-0 flex-1">
              <Text numberOfLines={1} className="font-pp-sans-medium text-[14px] text-text">{s.name ?? shortAddress(s.address)}</Text>
              {s.name ? <Text numberOfLines={1} className="font-pp-mono text-[11px] text-text-muted">{shortAddress(s.address)}</Text> : null}
            </View>
          </Pressable>
          <Pressable
            onPress={() => onEdit(s)}
            hitSlop={6}
            className="h-[52px] w-[48px] items-center justify-center active:opacity-[0.6]"
            accessibilityRole="button"
            accessibilityLabel={s.name ? `Edit name for ${s.name}` : 'Name this address'}
            testID={testID ? `${testID}-suggestion-${i}-edit` : undefined}
          >
            {/* nw-keep(data-color): pencil glyph is the secondary text token (vector-icon sink) */}
            <Ionicons name="pencil-outline" size={16} color={colors.textSecondary} />
          </Pressable>
        </View>
      ))}
      <Pressable onPress={onClose} className="items-center border-t border-border-light py-[8px] active:opacity-[0.6]" accessibilityRole="button" accessibilityLabel="Hide suggestions">
        {/* nw-keep(data-color): chevron glyph is the muted text token (vector-icon sink) */}
        <Ionicons name="chevron-up" size={16} color={colors.textMuted} />
      </Pressable>
    </View>
  );
}
