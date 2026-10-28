import { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, TextInput, useWindowDimensions, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Modal } from '@/components/ui/modal';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { useToast } from '@/components/toast-provider';
import { useBackHandler } from '@/hooks/use-back-handler';
import { useContacts } from '@/hooks/use-contacts';
import { ContactEditModal } from '@/components/contacts/contact-edit-modal';
import { CAN_PICK_FILE, pickContactsFile, saveContactsFile } from '@/components/contacts/contacts-file';
import { WEB_NO_OUTLINE, modalCardShadow } from '@/components/ui/web-style-shims';
import {
  applyContactsImport,
  buildContactsExport,
  CONTACTS_EXPORT_FILENAME,
  importSummary,
  parseContactsImport,
  planContactsImport,
  shortAddress,
  type ImportPlan,
} from '@/services/address-book-core';

type Pending = { plan: ImportPlan; invalid: number };

/**
 * Settings > Contacts: the saved names, with import and export. The file
 * holds address, name and the day each name was set. Nothing about notes,
 * payouts or the account.
 */
export function ContactsModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { toast } = useToast();
  const { owner, contacts, replaceAll } = useContacts();
  const { width } = useWindowDimensions();
  const sheet = width <= 540;
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [replaceNames, setReplaceNames] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [query, setQuery] = useState('');

  // Callers mount this only while open, so every opening starts clean.

  const close = useCallback(() => onClose(), [onClose]);
  useEffect(() => {
    if (Platform.OS !== 'web' || !visible || editing) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [visible, editing, close]);
  useBackHandler(visible && !editing, close);

  const readImport = useCallback((text: string) => {
    setResult(null);
    const parsed = parseContactsImport(text);
    if (!parsed.ok) { setError(parsed.error); setPending(null); return; }
    setError(null);
    setPasteOpen(false);
    setPasteText('');
    setReplaceNames(false);
    setPending({ plan: planContactsImport(contacts, parsed.contacts), invalid: parsed.invalid });
  }, [contacts]);

  const onImport = useCallback(async () => {
    if (!CAN_PICK_FILE) { setPasteOpen(true); setError(null); return; }
    const picked = await pickContactsFile();
    if (!picked) return;
    if ('error' in picked) { setError(picked.error); return; }
    readImport(picked.text);
  }, [readImport]);

  const confirmImport = useCallback(() => {
    if (!pending) return;
    const r = applyContactsImport(contacts, pending.plan, { replaceNames, invalid: pending.invalid, now: Date.now() });
    if (r.added + r.renamed > 0 && !replaceAll(r.list)) { setError('Could not save on this device.'); return; }
    const line = importSummary(r);
    setPending(null);
    setResult(line);
    toast({ title: 'Contacts imported', description: line, variant: 'success' });
  }, [pending, contacts, replaceNames, replaceAll, toast]);

  const onExport = useCallback(async () => {
    setResult(null);
    if (contacts.length === 0) return;
    const ok = await saveContactsFile(buildContactsExport(contacts), CONTACTS_EXPORT_FILENAME);
    if (ok) toast({ title: `${contacts.length} contact${contacts.length === 1 ? '' : 's'} exported` });
  }, [contacts, toast]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? contacts.filter((c) => c.name.toLowerCase().includes(q) || c.address.toLowerCase().includes(q)) : contacts;
  }, [contacts, query]);

  const inputBg = colorScheme === 'dark' ? 'bg-[#121314]' : 'bg-[#FAFAFA]';

  return (
    <Modal visible={visible} transparent animationType={sheet ? 'slide' : 'fade'} onRequestClose={close}>
      <Pressable className="absolute inset-0 bg-[rgba(0,0,0,0.5)]" onPress={close} accessibilityLabel="Close" />
      <View className={`flex-1 items-center ${sheet ? 'justify-end' : 'justify-center p-[20px]'}`} pointerEvents="box-none">
        <View
          className={`w-full overflow-hidden border border-border bg-card-background ${sheet ? 'max-h-[92%] rounded-t-[24px] border-b-0' : 'max-h-[86%] max-w-[460px] rounded-[20px]'}`}
          // nw-keep(platform-css): the shared modal card shadow (web box-shadow, native longhands)
          style={modalCardShadow(colorScheme)}
          testID="contacts-modal"
        >
          <View className="shrink-0 flex-row items-center gap-[10px] px-[20px] pb-[12px] pt-[20px]">
            <Text className="flex-1 font-pp-bold text-[18px] text-text" accessibilityRole="header">Contacts</Text>
            <Pressable onPress={close} hitSlop={8} accessibilityRole="button" accessibilityLabel="Close" testID="contacts-close">
              {/* nw-keep(data-color): close glyph is the secondary text token (vector-icon sink) */}
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </Pressable>
          </View>

          <View className="shrink-0 flex-row gap-[8px] px-[20px] pb-[12px]">
            <Pressable
              onPress={onImport}
              disabled={!owner}
              className={`h-[38px] flex-1 flex-row items-center justify-center gap-[6px] rounded-[12px] border border-border ${owner ? 'active:opacity-[0.8]' : 'opacity-[0.45]'}`}
              accessibilityRole="button"
              testID="contacts-import"
            >
              {/* nw-keep(data-color): glyph is the text token (vector-icon sink) */}
              <Ionicons name="download-outline" size={15} color={colors.text} />
              <Text className="font-pp-medium text-[13px] text-text">Import</Text>
            </Pressable>
            <Pressable
              onPress={onExport}
              disabled={contacts.length === 0}
              className={`h-[38px] flex-1 flex-row items-center justify-center gap-[6px] rounded-[12px] border border-border ${contacts.length === 0 ? 'opacity-[0.45]' : 'active:opacity-[0.8]'}`}
              accessibilityRole="button"
              testID="contacts-export"
            >
              {/* nw-keep(data-color): glyph is the text token (vector-icon sink) */}
              <Ionicons name="share-outline" size={15} color={colors.text} />
              <Text className="font-pp-medium text-[13px] text-text">Export</Text>
            </Pressable>
          </View>

          {error ? (
            <Text className="shrink-0 px-[20px] pb-[10px] font-pp-regular text-[12px] leading-[17px] text-danger" testID="contacts-error">{error}</Text>
          ) : null}
          {result ? (
            <View className="mx-[20px] mb-[10px] shrink-0 flex-row items-center gap-[8px] rounded-[12px] bg-background-secondary px-[12px] py-[9px]" testID="contacts-result">
              {/* nw-keep(data-color): check glyph is the success token (vector-icon sink) */}
              <Ionicons name="checkmark-circle" size={16} color={colors.success} />
              <Text className="flex-1 font-pp-medium text-[13px] text-text">{result}</Text>
            </View>
          ) : null}

          {pasteOpen ? (
            <View className="shrink-0 gap-[8px] px-[20px] pb-[12px]">
              <TextInput
                value={pasteText}
                onChangeText={setPasteText}
                multiline
                placeholder="Paste a contacts file"
                // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                testID="contacts-paste"
                className={`h-[110px] rounded-[12px] border border-border-light px-[12px] py-[10px] font-pp-mono text-[12px] text-text ${inputBg}`}
                // nw-keep(platform-css): web-only outline reset, the field draws its own border
                style={WEB_NO_OUTLINE}
              />
              <Pressable
                onPress={() => readImport(pasteText)}
                disabled={!pasteText.trim()}
                className={`h-[40px] items-center justify-center rounded-[12px] bg-button-primary ${pasteText.trim() ? 'active:opacity-[0.85]' : 'opacity-[0.45]'}`}
                accessibilityRole="button"
                testID="contacts-paste-read"
              >
                <Text className="font-pp-medium text-[14px] text-button-primary-text">Continue</Text>
              </Pressable>
            </View>
          ) : null}

          {pending ? (
            <View className="mx-[20px] mb-[12px] shrink-0 gap-[10px] rounded-[14px] border border-border-light p-[14px]" testID="contacts-review">
              <Text className="font-pp-sans-semi-bold text-[14px] text-text">
                {`${pending.plan.added.length} new${pending.plan.unchanged ? `, ${pending.plan.unchanged} already saved` : ''}${pending.invalid ? `, ${pending.invalid} unreadable` : ''}`}
              </Text>
              {pending.plan.conflicts.length > 0 ? (
                <Pressable
                  onPress={() => setReplaceNames((v) => !v)}
                  className="flex-row items-start gap-[8px]"
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: replaceNames }}
                  testID="contacts-review-replace"
                >
                  {/* nw-keep(data-color): checkbox glyph color is a theme token (vector-icon sink) */}
                  <Ionicons name={replaceNames ? 'checkbox' : 'square-outline'} size={18} color={replaceNames ? colors.buttonPrimary : colors.textMuted} />
                  <Text className="flex-1 font-pp-regular text-[12.5px] leading-[18px] text-text">
                    {`Use the file's name for ${pending.plan.conflicts.length} address${pending.plan.conflicts.length === 1 ? '' : 'es'} you named differently`}
                  </Text>
                </Pressable>
              ) : null}
              <View className="flex-row gap-[8px]">
                <Pressable onPress={() => setPending(null)} className="h-[40px] flex-1 items-center justify-center rounded-[12px] border border-border active:opacity-[0.8]" accessibilityRole="button" testID="contacts-review-cancel">
                  <Text className="font-pp-medium text-[13px] text-text">Cancel</Text>
                </Pressable>
                <Pressable onPress={confirmImport} className="h-[40px] flex-1 items-center justify-center rounded-[12px] bg-button-primary active:opacity-[0.85]" accessibilityRole="button" testID="contacts-review-confirm">
                  <Text className="font-pp-medium text-[13px] text-button-primary-text">Import</Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          {contacts.length > 6 ? (
            <View className="shrink-0 px-[20px] pb-[8px]">
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search"
                // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                testID="contacts-search"
                className={`h-[38px] rounded-[12px] border border-border-light px-[12px] font-pp-regular text-[13px] text-text ${inputBg}`}
                // nw-keep(platform-css): web-only outline reset, the field draws its own border
                style={WEB_NO_OUTLINE}
              />
            </View>
          ) : null}

          <ScrollView className="min-h-0 shrink grow-0" contentContainerClassName="px-[12px] pb-[18px]" showsVerticalScrollIndicator={false}>
            {!owner ? (
              <EmptyState icon="lock-closed-outline" title="Sign in to see your contacts" colors={colors} />
            ) : contacts.length === 0 ? (
              <EmptyState icon="people-outline" title="No contacts yet" hint="Name an address from any recipient field." colors={colors} />
            ) : shown.map((c) => (
              <Pressable
                key={c.address}
                onPress={() => setEditing(c.address)}
                className="flex-row items-center gap-[12px] rounded-[12px] px-[8px] py-[10px] hover:bg-background-secondary active:bg-background-secondary"
                accessibilityRole="button"
                accessibilityLabel={`${c.name}, ${c.address}. Edit`}
                testID={`contacts-row-${c.address}`}
              >
                <View className="h-[34px] w-[34px] items-center justify-center rounded-full bg-primary-soft">
                  <Text className="font-pp-sans-semi-bold text-[13px] text-primary">{Array.from(c.name)[0]!.toUpperCase()}</Text>
                </View>
                <View className="min-w-0 flex-1">
                  <Text numberOfLines={1} className="font-pp-sans-medium text-[14px] text-text">{c.name}</Text>
                  <Text numberOfLines={1} className="font-pp-mono text-[11.5px] text-text-muted">{shortAddress(c.address)}</Text>
                </View>
                {/* nw-keep(data-color): pencil glyph is the muted text token (vector-icon sink) */}
                <Ionicons name="pencil-outline" size={15} color={colors.textMuted} />
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </View>
      {editing ? <ContactEditModal key={editing} address={editing} onClose={() => setEditing(null)} /> : null}
    </Modal>
  );
}

function EmptyState({ icon, title, hint, colors }: { icon: keyof typeof Ionicons.glyphMap; title: string; hint?: string; colors: (typeof Colors)['dark'] }) {
  return (
    <View className="items-center gap-[8px] px-[16px] py-[28px]" testID="contacts-empty">
      <View className="h-[44px] w-[44px] items-center justify-center rounded-full bg-background-secondary">
        {/* nw-keep(data-color): glyph is the muted text token (vector-icon sink) */}
        <Ionicons name={icon} size={20} color={colors.textMuted} />
      </View>
      <Text className="font-pp-sans-medium text-[14px] text-text">{title}</Text>
      {hint ? <Text className="text-center font-pp-regular text-[12px] text-text-muted">{hint}</Text> : null}
    </View>
  );
}
