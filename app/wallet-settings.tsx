import { useState } from 'react';
import { Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useAccount, useDisconnect } from 'wagmi';

import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { useEmbeddedWallet } from '@/components/embedded-wallet-provider';
import { useWalletConnectModal } from '@/components/wallet-connect-modal-provider';
import { footerLinks, type FooterLink } from '@/components/ui/footer';
import { NewsletterModal } from '@/components/newsletter-modal';
import { isInternalHref } from '@/config/legal/routes';
import { ContactsModal } from '@/components/contacts/contacts-modal';

// Minimal settings for the embedded smart-wallet experience (ppv2 redesign).
function truncate(addr?: string) {
  return addr ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : '—';
}

export default function WalletSettingsScreen() {
  const { colorScheme, toggleColorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { address, isConnected, connector } = useAccount();
  const { meta } = useEmbeddedWallet();
  const { disconnect } = useDisconnect();
  const { open: openWalletPicker } = useWalletConnectModal();
  const [contactsOpen, setContactsOpen] = useState(false);

  const isEmbedded = connector?.id === 'pools-embedded';
  const securedBy =
    isEmbedded && meta?.protection === 'passkey'
      ? 'Passkey (biometric)'
      : isEmbedded
        ? 'Device keystore'
        : connector?.name ?? 'External wallet';

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView contentContainerClassName="grow pb-[96px]">
        <View className="w-full max-w-[560px] gap-[16px] self-center px-[18px] pt-[22px]">
          <Text className="font-pp-sans-bold text-[24px] text-text">Settings</Text>

          <Group label="ACCOUNT">
            <Row icon="badge" label="Address" value={truncate(address)} colors={colors} />
            <Row icon="key" label="Secured by" value={securedBy} tint={colors.tint} colors={colors} />
            {!isConnected && (
              <RowButton icon="login" label="Create or connect a wallet" onPress={() => openWalletPicker()} tint={colors.tint} colors={colors} />
            )}
          </Group>

          <Group label="APPEARANCE">
            <RowButton
              icon={colorScheme === 'dark' ? 'dark-mode' : 'light-mode'}
              label={`Theme: ${colorScheme === 'dark' ? 'Dark' : 'Light'}`}
              hint="tap to switch"
              onPress={toggleColorScheme}
              colors={colors}
            />
          </Group>

          <Group label="CONTACTS">
            <RowButton icon="people-outline" label="Contacts" hint="import, export" onPress={() => setContactsOpen(true)} colors={colors} />
          </Group>

          <Group label="NETWORK">
            <Row icon="lan" label="Chain" value="Sepolia testnet" tint={colors.tint} colors={colors} />
            <Row icon="verified-user" label="Compliance" value="0xbow ASP" colors={colors} />
          </Group>

          {isConnected && (
            <Pressable
              onPress={() => disconnect()}
              // Pressed opacity is class-authored: a `style` FUNCTION on a className'd
              // Pressable is arrayed by css-interop's web runtime and never invoked
              // (RN-Web Pressable only calls a top-level style function).
              className="mt-[4px] flex-row items-center justify-center gap-[8px] rounded-control border border-[#ff6b5e] py-[14px] active:opacity-[0.85]"
            >
              {/* nw-keep(data-color): fixed sign-out danger-red glyph (vector-icon color prop) */}
              <MaterialIcons name="logout" size={16} color="#ff6b5e" />
              <Text className="font-pp-sans-semi-bold text-[13px] text-[#ff6b5e]">Sign out</Text>
            </Pressable>
          )}

          <AboutSection colors={colors} />
          {contactsOpen ? <ContactsModal visible onClose={() => setContactsOpen(false)} /> : null}

          <Text className="mt-[6px] text-center font-pp-sans text-[9px] tracking-[0.5px] text-text-muted">
            Privacy Pools v2 · passkey-secured smart wallet
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

type C = (typeof Colors)['dark'];

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View className="gap-[7px]">
      <Text className="px-[2px] font-pp-sans-semi-bold text-[10px] tracking-[2px] text-text-muted">{label}</Text>
      <View className="overflow-hidden rounded-control border border-border bg-card-background">{children}</View>
    </View>
  );
}

function Row({ icon, label, value, tint, colors }: { icon: keyof typeof MaterialIcons.glyphMap; label: string; value: string; tint?: string; colors: C }) {
  return (
    <View className="flex-row items-center gap-[10px] border-t-border px-[14px] py-[13px]">
      {/* nw-keep(data-color): muted row-icon token (vector-icon color prop) */}
      <MaterialIcons name={icon} size={16} color={colors.textMuted} />
      <Text className="flex-1 font-pp-sans text-[12px] text-text-secondary">{label}</Text>
      {/* nw-keep(data-color): value color is the optional tint token or the text token (runtime prop, no className path) */}
      <Text className="font-pp-sans-medium text-[12px]" style={{ color: tint ?? colors.text }}>{value}</Text>
    </View>
  );
}

function RowButton({ icon, label, hint, tint, onPress, colors }: { icon: keyof typeof MaterialIcons.glyphMap; label: string; hint?: string; tint?: string; onPress: () => void; colors: C }) {
  return (
    // nw-keep(third-party-style-api): pressed-state opacity from the RN Pressable style callback (no className path under the parity freeze)
    <Pressable onPress={onPress} style={({ pressed }) => pressed && { opacity: 0.8 }}>
      <View className="flex-row items-center gap-[10px] border-t-border px-[14px] py-[13px]">
        {/* nw-keep(data-color): row-icon color is the optional tint token or muted token (vector-icon color prop) */}
        <MaterialIcons name={icon} size={16} color={tint ?? colors.textMuted} />
        {/* nw-keep(data-color): label color is the optional tint token or text token (runtime prop, no className path) */}
        <Text className="flex-1 font-pp-sans-medium text-[12px]" style={{ color: tint ?? colors.text }}>{label}</Text>
        {hint ? <Text className="font-pp-sans text-[10px] text-text-muted">{hint}</Text> : null}
        {/* nw-keep(data-color): chevron muted token (vector-icon color prop) */}
        <MaterialIcons name="chevron-right" size={16} color={colors.textMuted} />
      </View>
    </Pressable>
  );
}

function AboutSection({ colors }: { colors: C }) {
  const router = useRouter();
  const [newsletterOpen, setNewsletterOpen] = useState(false);

  const onPress = (link: FooterLink) => {
    if (link.action === 'newsletter') {
      setNewsletterOpen(true);
      return;
    }
    if (isInternalHref(link.href)) {
      router.push(link.href as never);
      return;
    }
    if (link.href) Linking.openURL(link.href);
  };

  return (
    <View className="gap-[7px]">
      <Text className="px-[2px] font-pp-sans-semi-bold text-[10px] tracking-[2px] text-text-muted">ABOUT</Text>
      <View className="flex-row flex-wrap gap-[8px] rounded-control border border-border bg-card-background p-[12px]">
        {footerLinks.map((link) => (
          <Pressable
            key={link.label}
            onPress={() => onPress(link)}
            className="flex-row items-center gap-[6px] rounded-pill border border-border bg-background-secondary px-[12px] py-[8px] active:opacity-[0.7]"
            accessibilityRole={link.action === 'newsletter' ? 'button' : 'link'}
          >
            <Text className="font-pp-sans-medium text-[12px] text-text-secondary">
              {link.label}
            </Text>
            {/* nw-keep(data-color): muted trailing glyph token (vector-icon color prop) */}
            <MaterialIcons
              name={link.action === 'newsletter' ? 'mail-outline' : isInternalHref(link.href) ? 'chevron-right' : 'open-in-new'}
              size={12}
              color={colors.textMuted}
            />
          </Pressable>
        ))}
      </View>
      <NewsletterModal visible={newsletterOpen} onClose={() => setNewsletterOpen(false)} />
    </View>
  );
}
