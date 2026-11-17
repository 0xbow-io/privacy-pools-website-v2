/** Varial inside the existing wallet picker, with local branding. */
import React, { useEffect, useRef, useState } from 'react';
import { Image, Linking, Platform, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useStellarWallet } from '@/components/stellar-wallet-provider';
import { useDebug } from '@/components/debug-provider';
import { isChainSelectable, STELLAR_TESTNET_ID, supportedChainIds } from '@/config/chains';
import { useChainRouter } from '@/hooks/use-chain-router';
import { ChainLogo } from '@/components/ui/chain-logo';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';

export function StellarWalletOption({ className, onConnected }: { className: string; onConnected?: () => void }) {
  const { isDebugEnabled } = useDebug();
  const enabled = supportedChainIds.includes(STELLAR_TESTNET_ID) && isChainSelectable(STELLAR_TESTNET_ID, isDebugEnabled);
  const wallet = useStellarWallet();
  const { selectChain } = useChainRouter();
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { cancelConnect, isDevBurner } = wallet;
  const available = isDevBurner ? true : Platform.OS !== 'web' ? false
    : wallet.availabilityChecked ? wallet.isAvailable : null;
  const attempt = useRef({ mounted: true, pending: false });
  useEffect(() => {
    const current = attempt.current;
    current.mounted = true;
    return () => {
      current.mounted = false;
      if (current.pending) cancelConnect();
    };
  }, [cancelConnect]);

  if (!enabled) return null;

  const onPress = async () => {
    if (attempt.current.pending) return;
    if (available === false) {
      if (Platform.OS === 'web' && typeof window !== 'undefined') window.open('https://varialwallet.com', '_blank', 'noopener,noreferrer');
      else void Linking.openURL('https://varialwallet.com').catch(() => setError('Could not open the Varial website.'));
      return;
    }
    attempt.current.pending = true;
    setPending(true);
    setError(null);
    try {
      const outcome = await selectChain(STELLAR_TESTNET_ID);
      if (outcome !== 'committed' || !attempt.current.mounted) return;
      const { address, error } = await wallet.connectDetailed();
      if (attempt.current.mounted) setError(error);
      attempt.current.pending = false;
      if (address && attempt.current.mounted) onConnected?.();
    } catch (error) {
      if (attempt.current.mounted) setError(error instanceof Error ? error.message : 'Could not connect to Varial. Try again.');
    } finally {
      attempt.current.pending = false;
      if (attempt.current.mounted) setPending(false);
    }
  };

  return (
    <Pressable
      onPress={() => { void onPress(); }}
      disabled={pending || wallet.status === 'connecting'}
      accessibilityRole="button"
      accessibilityState={{ disabled: pending || wallet.status === 'connecting', busy: pending }}
      className={`${className} ${pending ? 'opacity-50' : 'opacity-100'}`}
    >
      <View className="h-[36px] w-[36px] items-center justify-center overflow-hidden rounded-[10px] bg-card-background">
        {!isDevBurner ? (
          <Image
            source={colorScheme === 'dark'
              ? require('@/assets/images/wallets/varial-dark.png')
              : require('@/assets/images/wallets/varial.png')}
            // nw-keep(third-party-style-api): React Native Web Image's intrinsic 128px size overrides class dimensions; explicit style prevents clipping.
            style={{ width: 28, height: 28 }}
            resizeMode="contain"
            accessibilityElementsHidden
          />
        ) : <ChainLogo chain="stellar-testnet" size={24} />}
      </View>
      <View className="min-w-0 flex-1 gap-[2px]">
        <Text className="font-pp-medium text-[14px] text-text" numberOfLines={1}>{wallet.isDevBurner ? 'Stellar test key' : 'Varial'}</Text>
        <Text className="font-pp-regular text-[12px] text-text-secondary" numberOfLines={1}>
          {pending ? 'Connecting…' : isDevBurner ? 'Stellar Testnet' : available === false ? 'Get Varial for Stellar Testnet' : 'Browser extension · Stellar Testnet'}
        </Text>
        {error ? <Text className="font-pp-regular text-[12px] text-[#E11D48]">{error}</Text> : null}
      </View>
      {available === true && !isDevBurner && !pending && wallet.status !== 'connecting' && (
        <View className="rounded-control bg-background-secondary px-[7px] py-[4px]">
          <Text className="font-pp-medium text-[10px] text-text-secondary">Installed</Text>
        </View>
      )}
      {/* nw-keep(data-color): glyph color is a theme token into the vector-icon sink */}
      <Ionicons name="chevron-forward" size={15} color={colors.textMuted} />
    </Pressable>
  );
}
