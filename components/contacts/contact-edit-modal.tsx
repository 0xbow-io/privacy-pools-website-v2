import { useCallback, useEffect, useState } from 'react';
import { Animated, Easing, Platform, Pressable, Text, TextInput, useWindowDimensions, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Modal } from '@/components/ui/modal';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { useToast } from '@/components/toast-provider';
import { useBackHandler } from '@/hooks/use-back-handler';
import { useContacts } from '@/hooks/use-contacts';
import { WEB_NO_OUTLINE, modalCardShadow } from '@/components/ui/web-style-shims';
import { canonicalAddress, MAX_CONTACT_NAME_LENGTH } from '@/services/address-book-core';
import { copyText } from '@/services/copy-text';

/**
 * Name, rename or clear the saved name of one address. Local only: the name
 * is written to this device's contact list for the signed-in account and
 * never leaves it.
 */
export function ContactEditModal({ address, adding = false, onClose }: {
  address: string | null;
  /** "Add address": the address is typed here (validated per chain format, deduped). */
  adding?: boolean;
  onClose: () => void;
}) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { toast } = useToast();
  const { contacts, setName, addContact, owner } = useContacts();
  const [typedAddress, setTypedAddress] = useState('');
  const { width } = useWindowDimensions();
  const sheet = width <= 540;
  const visible = adding || !!address;
  const canon = canonicalAddress(adding ? typedAddress : address);
  const existing = canon ? contacts.find((c) => canonicalAddress(c.address)?.key === canon.key) ?? null : null;
  // Mounted per address (callers key it), so the field seeds once from the saved name.
  const [name, setNameText] = useState(() => existing?.name ?? '');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [appear] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (!visible) return;
    Animated.timing(appear, { toValue: 1, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== 'web' }).start();
  }, [visible, appear]);

  useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', h, true);
    return () => document.removeEventListener('keydown', h, true);
  }, [visible, onClose]);
  useBackHandler(visible, onClose);

  const save = useCallback((value: string) => {
    if (adding) {
      const err = addContact(typedAddress, value);
      if (err) { setError(err); return; }
      toast({ title: 'Address saved' });
      onClose();
      return;
    }
    if (!canon) return;
    const err = setName(canon.display, value);
    if (err) { setError(err); return; }
    if (!value.trim() && existing) toast({ title: 'Name removed' });
    onClose();
  }, [adding, addContact, typedAddress, canon, setName, existing, onClose, toast]);

  const copy = useCallback(async () => {
    if (!canon) return;
    if (await copyText(canon.display)) {
      setCopied(true);
      toast({ title: 'Address copied' });
    }
  }, [canon, toast]);

  if (!canon && !adding) return null;
  const dirty = adding ? !!name.trim() && !!typedAddress.trim() : name.trim() !== (existing?.name ?? '');

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      {/* nw-keep(animated): backdrop opacity rides the shared Animated.Value */}
      <Animated.View className="absolute inset-0 bg-[rgba(0,0,0,0.5)]" style={{ opacity: appear }}>
        <Pressable className="flex-1" onPress={onClose} accessibilityLabel="Close" testID="contact-edit-backdrop" />
      </Animated.View>
      <View className={`flex-1 items-center ${sheet ? 'justify-end' : 'justify-center p-[20px]'}`} pointerEvents="box-none">
        <Animated.View
          className={`w-full border border-border bg-card-background ${sheet ? 'rounded-t-[24px] border-b-0 px-[20px] pb-[28px] pt-[22px]' : 'max-w-[420px] rounded-[20px] p-[22px]'}`}
          // nw-keep(animated): card fades and lifts in on open (Animated.Value); the shadow follows the scheme
          style={[
            modalCardShadow(colorScheme),
            {
              opacity: appear,
              transform: [
                { translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [sheet ? 24 : 8, 0] }) },
                { scale: appear.interpolate({ inputRange: [0, 1], outputRange: [sheet ? 1 : 0.98, 1] }) },
              ],
            },
          ]}
          accessibilityViewIsModal
          testID="contact-edit-modal"
        >
          <View className="flex-row items-center gap-[12px]">
            <View className="h-[40px] w-[40px] items-center justify-center rounded-full bg-primary-soft">
              {/* nw-keep(data-color): glyph is the primary theme token (vector-icon sink) */}
              <Ionicons name="person-outline" size={18} color={colors.primary} />
            </View>
            <Text className="flex-1 font-pp-sans-semi-bold text-[17px] text-text" accessibilityRole="header">
              {adding ? 'Add address' : existing ? 'Edit name' : 'Name this address'}
            </Text>
            <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close" testID="contact-edit-close">
              {/* nw-keep(data-color): close glyph is the secondary text token (vector-icon sink) */}
              <Ionicons name="close" size={20} color={colors.textSecondary} />
            </Pressable>
          </View>

          {adding ? (
            <TextInput
              autoFocus
              value={typedAddress}
              onChangeText={(t) => { setTypedAddress(t.trim()); setError(null); }}
              placeholder="0x… or G… address"
              // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!!owner}
              accessibilityLabel="Address"
              testID="contact-add-address"
              className={`mt-[16px] h-[46px] rounded-[12px] border px-[14px] font-pp-mono text-[13px] text-text ${typedAddress && !canon ? 'border-danger' : 'border-border-light'} ${colorScheme === 'dark' ? 'bg-[#121314]' : 'bg-[#FAFAFA]'}`}
              // nw-keep(platform-css): web-only outline reset, the field draws its own border
              style={WEB_NO_OUTLINE}
            />
          ) : canon ? (
          <Pressable
            onPress={copy}
            className="mt-[16px] flex-row items-center gap-[10px] rounded-[12px] bg-background-secondary px-[12px] py-[10px] active:opacity-[0.8]"
            accessibilityRole="button"
            accessibilityLabel="Copy address"
            testID="contact-edit-copy"
          >
            <Text selectable className="flex-1 font-pp-mono text-[12px] leading-[17px] text-text-secondary" testID="contact-edit-address">
              {canon?.display}
            </Text>
            {/* nw-keep(data-color): copy glyph switches to the success token once copied (vector-icon sink) */}
            <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={16} color={copied ? colors.success : colors.textMuted} />
          </Pressable>
          ) : null}

          <TextInput
            autoFocus={!adding}
            value={name}
            onChangeText={(t) => { setNameText(t); setError(null); }}
            onSubmitEditing={() => { if (owner) save(name); }}
            placeholder="Name"
            // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
            placeholderTextColor={colors.textMuted}
            maxLength={MAX_CONTACT_NAME_LENGTH}
            autoCorrect={false}
            returnKeyType="done"
            editable={!!owner}
            accessibilityLabel="Contact name"
            testID="contact-edit-name"
            className={`mt-[12px] h-[46px] rounded-[12px] border px-[14px] font-pp-regular text-[15px] text-text ${error ? 'border-danger' : 'border-border-light'} ${colorScheme === 'dark' ? 'bg-[#121314]' : 'bg-[#FAFAFA]'}`}
            // nw-keep(platform-css): web-only outline reset, the field draws its own border
            style={WEB_NO_OUTLINE}
          />
          {error ? (
            <Text className="mt-[6px] font-pp-regular text-[12px] text-danger" testID="contact-edit-error">{error}</Text>
          ) : (
            <Text className="mt-[6px] font-pp-regular text-[11.5px] text-text-muted">
              {owner ? 'Saved on this device only.' : 'Sign in to save names.'}
            </Text>
          )}

          <View className="mt-[18px] flex-row items-center gap-[10px]">
            {existing && !adding ? (
              <Pressable
                onPress={() => save('')}
                className="h-[44px] items-center justify-center rounded-[12px] px-[12px] active:opacity-[0.7]"
                accessibilityRole="button"
                testID="contact-edit-remove"
              >
                <Text className="font-pp-medium text-[13px] text-danger">Remove</Text>
              </Pressable>
            ) : null}
            <View className="flex-1" />
            <Pressable
              onPress={onClose}
              className="h-[44px] items-center justify-center rounded-[12px] border border-border px-[16px] active:opacity-[0.8]"
              accessibilityRole="button"
              testID="contact-edit-cancel"
            >
              <Text className="font-pp-medium text-[14px] text-text">Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => save(name)}
              disabled={!owner || !dirty}
              className={`h-[44px] min-w-[96px] items-center justify-center rounded-[12px] bg-button-primary px-[18px] ${!owner || !dirty ? 'opacity-[0.45]' : 'active:opacity-[0.85]'}`}
              accessibilityRole="button"
              accessibilityState={{ disabled: !owner || !dirty }}
              testID="contact-edit-save"
            >
              <Text className="font-pp-medium text-[14px] text-button-primary-text">Save</Text>
            </Pressable>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}
