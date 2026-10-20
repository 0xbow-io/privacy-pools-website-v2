import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useAccount } from 'wagmi';

import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { Logo } from '@/components/ui/logo';
import { useEmbeddedWallet } from '@/components/embedded-wallet-provider';
import { useWalletConnectModal } from '@/components/wallet-connect-modal-provider';
import { smartWalletActive } from '@/config/smart-wallet';
import { PasskeySignInPanel } from '@/components/passkey-sign-in-panel';

// First-run onboarding for the seedphrase-free embedded smart wallet, styled
// with ppv2's theme tokens. Shows full-screen
// until the user has a wallet (or chooses to browse / connect an existing one).
// Only mounts when smartWalletActive() — otherwise ppv2's normal flow is intact.

const SKIP_KEY = 'ppv2_smartwallet_skipped_v1';

// nw-keep(platform-css): web pins the overlay with position:fixed (RN has no
// 'fixed'); the absolute/inset/centering all live in className. Native stays absolute.
const WEB_FIXED = Platform.OS === 'web' ? ({ position: 'fixed' } as object) : null;

function readSkipped(): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(SKIP_KEY) === '1';
  } catch {
    return false;
  }
}
function writeSkipped() {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SKIP_KEY, '1');
  } catch {
    // ignore
  }
}

export function SmartWalletOnboardingOverlay() {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { width } = useWindowDimensions();
  const isPhone = width <= 540;

  const { isConnected } = useAccount();
  const { exists, passkeyAvailable, busy, error, create, unlock, recover } = useEmbeddedWallet();
  const { open: openWalletPicker } = useWalletConnectModal();

  // Flag OFF (web without the flag): never touch localStorage — the overlay
  // must be a pure no-op then. Every other storage/probe path is behind the
  // same gate (shouldShow below, EmbeddedWalletProvider.refresh()).
  const [skipped, setSkipped] = useState(() => (smartWalletActive() ? readSkipped() : false));
  const fade = useRef(new Animated.Value(0)).current;
  const lift = useRef(new Animated.Value(16)).current;

  const shouldShow = smartWalletActive() && exists !== null && !isConnected && !skipped;

  useEffect(() => {
    if (shouldShow) {
      Animated.parallel([
        Animated.timing(fade, { toValue: 1, duration: 420, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(lift, { toValue: 0, duration: 480, useNativeDriver: Platform.OS !== 'web' }),
      ]).start();
    }
  }, [shouldShow, fade, lift]);

  if (!shouldShow) return null;

  const hasExisting = exists === true;

  const onPrimary = async () => {
    try {
      if (hasExisting) await unlock();
      else await create();
    } catch {
      // surfaced via context error
    }
  };
  const onRecover = async () => {
    try {
      await recover();
    } catch {
      // surfaced via context error
    }
  };
  const onConnectExisting = async () => {
    writeSkipped();
    setSkipped(true);
    await openWalletPicker();
  };
  const onSkip = () => {
    writeSkipped();
    setSkipped(true);
  };

  const primaryLabel = hasExisting ? 'Unlock wallet' : 'Create wallet';
  const subtitle = hasExisting
    ? 'Welcome back. Unlock your private wallet to continue.'
    : passkeyAvailable
      ? 'Secured by your device passkey. No seed phrase, no extension. And recoverable from your passkey alone.'
      : 'Private and secured on this device. No seed phrase to write down. Ever.';

  return (
    <View
      className="absolute inset-0 z-[1000] bg-background"
      style={WEB_FIXED}
      pointerEvents="auto"
    >
      {/* Scrolls so the lower actions stay reachable on short phones. */}
      <ScrollView
        className="flex-1"
        contentContainerClassName="grow items-center justify-center p-[24px]"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Animated.View
          className="w-full items-center py-[12px]"
          // nw-keep(measured-or-inset): responsive max width from the frozen 540px phone breakpoint
          // nw-keep(animated): entrance fade + translateY driven by Animated.Value (no className path)
          style={{ maxWidth: isPhone ? '100%' : 460, opacity: fade, transform: [{ translateY: lift }] }}
        >
          <View className="mb-[24px]">
            <Logo width={76} height={76} variant={colorScheme === 'dark' ? 'white' : 'black'} />
          </View>

          <Text className="mb-[10px] font-pp-semi-bold text-[12px] tracking-[3px] text-tint">PRIVACY POOLS</Text>
          <Text className="mb-[12px] text-center font-pp-bold text-[30px] leading-[36px] text-text">
            {hasExisting ? 'Your private wallet' : 'Privacy you can prove.'}
          </Text>
          <Text className="mb-[24px] max-w-[380px] text-center font-pp-regular text-[15px] leading-[22px] text-text-secondary">{subtitle}</Text>

          {!hasExisting && (
            <View className="mb-[28px] gap-[12px] self-stretch px-[8px]">
              <Bullet color={colors.textSecondary} accent={colors.tint} text="No seed phrase, no extensions" />
              <Bullet
                color={colors.textSecondary}
                accent={colors.tint}
                text={passkeyAvailable ? 'Unlocked by fingerprint / Face ID' : 'Secured on this device'}
              />
              <Bullet color={colors.textSecondary} accent={colors.tint} text="Shield, send & withdraw privately" />
            </View>
          )}

          {error ? (
            <View className="mb-[16px] self-stretch rounded-control border border-border bg-background-secondary p-[12px]">
              <Text className="text-center font-pp-regular text-[13px] text-[#ff6b5e]">{error}</Text>
            </View>
          ) : null}

          {/* Native: sign in with the privacypools.com passkey first (renders nothing on web). */}
          {Platform.OS !== 'web' && (
            <View className="mb-[12px] self-stretch">
              <PasskeySignInPanel colors={colors} />
            </View>
          )}

          <Pressable
            onPress={onPrimary}
            disabled={busy}
            className={`mb-[12px] h-[56px] items-center justify-center self-stretch rounded-inner bg-button-primary ${busy ? 'opacity-70' : 'active:opacity-[0.88]'}`}
          >
            {busy ? (
              // nw-keep(data-color): spinner tint is a theme token fed to the ActivityIndicator color prop (no className path)
              <ActivityIndicator color={colors.buttonPrimaryText} />
            ) : (
              <Text className="font-pp-semi-bold text-[17px] text-button-primary-text">
                {primaryLabel}
              </Text>
            )}
          </Pressable>

          {!hasExisting && passkeyAvailable && (
            <Pressable onPress={onRecover} disabled={busy} className="h-[46px] items-center justify-center self-stretch">
              <Text className="font-pp-medium text-[14px] text-tint">
                Recover with passkey
              </Text>
            </Pressable>
          )}

          <Pressable onPress={onConnectExisting} disabled={busy} className="h-[46px] items-center justify-center self-stretch">
            <Text className="font-pp-medium text-[14px] text-text-secondary">
              I already have a wallet
            </Text>
          </Pressable>

          <Pressable onPress={onSkip} disabled={busy} className="mt-[6px] p-[8px]">
            <Text className="font-pp-regular text-[13px] text-text-muted">
              Just browse the pools →
            </Text>
          </Pressable>
        </Animated.View>
      </ScrollView>
    </View>
  );
}

function Bullet({ text, color, accent }: { text: string; color: string; accent: string }) {
  return (
    <View className="flex-row items-center gap-[12px]">
      {/* nw-keep(data-color): accent dot color is a runtime theme token passed in as a prop (no className path) */}
      <View className="h-[6px] w-[6px] rounded-[3px]" style={{ backgroundColor: accent }} />
      {/* nw-keep(data-color): bullet text color is a runtime theme token passed in as a prop */}
      <Text className="flex-1 text-[14px]" style={{ color }}>{text}</Text>
    </View>
  );
}
