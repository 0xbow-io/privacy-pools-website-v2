import { useCallback, useId, useState, type ReactNode } from 'react';
import { Platform, View, type NativeSyntheticEvent, type TextInputKeyPressEventData } from 'react-native';
import { AddressSuggestionsList } from '@/components/contacts/address-suggestions-list';
import { ContactEditModal } from '@/components/contacts/contact-edit-modal';
import { useRecipientSuggestions } from '@/hooks/use-contacts';
import type { AddressFormat } from '@/services/address-book-core';
import { recipientListState, type RecipientSuggestion } from '@/services/recipient-suggestions';

/** Spread onto the field's TextInput. */
export type AddressInputBind = {
  onFocus: () => void;
  onBlur: () => void;
  onKeyPress: (e: NativeSyntheticEvent<TextInputKeyPressEventData>) => void;
  accessibilityHint?: string;
} & Record<string, unknown>;

/**
 * The one recipient autocomplete every address field uses (Withdraw, Send,
 * Swap, Shield "Deposit to"). It wraps the surface's own input, so each keeps
 * its look and its validation: picking a row only calls `onSelect(address)`,
 * the same path as typing it.
 *
 * Rows come from this device's payout records and saved contacts
 * (hooks/use-contacts.ts), filtered to the formats the field accepts. No
 * request is made to build or show them.
 */
export function AddressAutocomplete({
  value,
  onSelect,
  formats,
  exclude,
  disabled,
  testID,
  children,
}: {
  value: string;
  onSelect: (address: string) => void;
  /** Address formats this field accepts (a cross-chain field passes its DESTINATION's). */
  formats: readonly AddressFormat[];
  /** Addresses not worth suggesting here (e.g. the user's own). */
  exclude?: readonly string[];
  disabled?: boolean;
  testID?: string;
  children: (bind: AddressInputBind) => ReactNode;
}) {
  // Engaged from focus until a pick, Escape, Tab, the hide row, or (web) blur.
  const [engaged, setEngaged] = useState(false);
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [editing, setEditing] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<unknown>(null);
  const listId = `addr-ac-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const { suggestions, refresh, ready, activityLoading } = useRecipientSuggestions({ formats, query: value, exclude });

  // Typing again after a pick or Escape brings the list back (state adjusted
  // during render, React's pattern for "reset when a prop changes").
  const formatsKey = formats.join(',');
  const [seen, setSeen] = useState({ value, formatsKey });
  if (seen.value !== value || seen.formatsKey !== formatsKey) {
    setSeen({ value, formatsKey });
    setActiveIndex(-1);
    if (focused) setEngaged(true);
  }

  // Web closes on blur (rows prevent mousedown, so a click on the list never
  // blurs the field); native keeps the in-flow list after blur until a pick or
  // the hide row (the first tap on a row may only dismiss the keyboard).
  // A field holding an address the list knows shows nothing (ranking returns []).
  const open = !disabled && engaged && suggestions.length > 0;
  // Focus always answers: an empty field with nothing to suggest (a new
  // device, or a domain whose storage holds no records) shows a short empty
  // state instead of nothing. While typing, no match just means no list.
  const listState = recipientListState({ rows: suggestions.length, query: value, deviceReady: ready, activityLoading });
  const showEmpty = !disabled && engaged && listState === 'empty';
  const showLoading = !disabled && engaged && listState === 'loading';

  const pick = useCallback((s: RecipientSuggestion) => {
    onSelect(s.address);
    setEngaged(false);
    setActiveIndex(-1);
  }, [onSelect]);

  const edit = useCallback((s: RecipientSuggestion) => {
    setEngaged(false);
    setEditing(s.address);
  }, []);

  const onFocus = useCallback(() => {
    setFocused(true);
    setEngaged(true);
    refresh();
  }, [refresh]);

  const onBlur = useCallback(() => {
    setFocused(false);
    if (Platform.OS === 'web') setEngaged(false);
  }, []);

  const onKeyPress = useCallback((e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    const key = e.nativeEvent.key;
    const ev = e as unknown as { preventDefault?: () => void; stopPropagation?: () => void };
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      if (!open) {
        if (key === 'ArrowDown') setEngaged(true);
        return;
      }
      ev.preventDefault?.();
      const n = suggestions.length;
      setActiveIndex((i) => (key === 'ArrowDown' ? (i + 1) % n : i <= 0 ? n - 1 : i - 1));
      return;
    }
    if (!open) return;
    if (key === 'Enter' && activeIndex >= 0 && suggestions[activeIndex]) {
      ev.preventDefault?.();
      pick(suggestions[activeIndex]);
    } else if (key === 'Escape') {
      // Close the list, not the modal around the field.
      ev.preventDefault?.();
      ev.stopPropagation?.();
      setEngaged(false);
    } else if (key === 'Tab') {
      setEngaged(false);
    }
  }, [open, suggestions, activeIndex, pick]);

  const bind: AddressInputBind = {
    onFocus,
    onBlur,
    onKeyPress,
    ...(Platform.OS === 'web'
      ? {
        role: 'combobox',
        'aria-autocomplete': 'list',
        'aria-expanded': open || showEmpty || showLoading,
        'aria-controls': listId,
        'aria-activedescendant': open && activeIndex >= 0 ? `${listId}-opt-${activeIndex}` : undefined,
      }
      : { accessibilityHint: suggestions.length > 0 ? 'Previous recipients are listed below' : undefined }),
  };

  return (
    <View className="w-full">
      <View ref={setAnchor as never} className="w-full" collapsable={false}>
        {children(bind)}
      </View>
      <AddressSuggestionsList
        open={open}
        empty={showEmpty}
        loading={showLoading}
        anchor={anchor}
        listId={listId}
        suggestions={suggestions}
        activeIndex={activeIndex}
        onHover={setActiveIndex}
        onSelect={pick}
        onEdit={edit}
        onClose={() => setEngaged(false)}
        testID={testID}
      />
      {editing ? <ContactEditModal key={editing} address={editing} onClose={() => setEditing(null)} /> : null}
    </View>
  );
}
