/**
 * "Freighter · Stellar Testnet" and "MetaMask · Stellar" rows for the wallet pickers.
 *
 * The pickers list wagmi connectors, which cannot connect a Stellar wallet,
 * and unlike dapp-kit's autoConnect for Sui nothing else offers Freighter to a
 * first-time visitor. Shown where Stellar is served and selectable (debug mode
 * or ?stellar=true, the same gate as the chain selector); picking one selects the Stellar chain
 * and asks that wallet for access. The MetaMask row appears only when the
 * extension is found. MetaMask signs Stellar mainnet only, so connecting it
 * on Testnet says so (see services/stellar/metamask-stellar.ts).
 */
import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useStellarWallet } from '@/components/stellar-wallet-provider';
import { useToast } from '@/components/toast-provider';
import { useDebug } from '@/components/debug-provider';
import { isChainSelectable, STELLAR_TESTNET_ID, supportedChainIds } from '@/config/chains';
import { useChainRouter } from '@/hooks/use-chain-router';
import { ChainLogo } from '@/components/ui/chain-logo';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import type { StellarWalletKind } from '@/services/stellar/stellar-wallet-choice';

export function StellarWalletOption({ className, onConnected }: { className: string; onConnected?: () => void }) {
  const { isDebugEnabled } = useDebug();
  const wallet = useStellarWallet();

  if (!supportedChainIds.includes(STELLAR_TESTNET_ID) || !isChainSelectable(STELLAR_TESTNET_ID, isDebugEnabled)) return null;

  return (
    <>
      <StellarWalletRow kind="freighter" className={className} onConnected={onConnected} />
      {wallet.walletAvailable.metamask ? <StellarWalletRow kind="metamask" className={className} onConnected={onConnected} /> : null}
    </>
  );
}

function StellarWalletRow({ kind, className, onConnected }: { kind: StellarWalletKind; className: string; onConnected?: () => void }) {
  const wallet = useStellarWallet();
  const { toast } = useToast();
  const { selectChain } = useChainRouter();
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const isMetaMask = kind === 'metamask';
  const available = wallet.walletAvailable[kind];

  const onPress = async () => {
    // Only a finished probe that found nothing means 'not installed'.
    if (!isMetaMask && wallet.availabilityChecked && !available) {
      if (typeof window !== 'undefined') window.open('https://www.freighter.app', '_blank', 'noopener');
      return;
    }
    setPending(true);
    try {
      const outcome = await selectChain(STELLAR_TESTNET_ID);
      if (outcome !== 'committed') return;
      setFailure(null);
      const { address, notice, error } = await wallet.connectDetailed(kind);
      if (!address) setFailure(error);
      if (address && notice) toast({ title: notice, variant: 'destructive' });
      if (address) onConnected?.();
    } finally {
      setPending(false);
    }
  };

  return (
    <Pressable
      onPress={() => { void onPress(); }}
      disabled={pending}
      accessibilityRole="button"
      accessibilityState={{ disabled: pending, busy: pending }}
      className={`${className} ${pending ? 'opacity-50' : 'opacity-100'}`}
    >
      <View className="h-[36px] w-[36px] items-center justify-center overflow-hidden rounded-[10px] bg-card-background">
        {isMetaMask
          // nw-keep(data-color): glyph color is a theme token into the vector-icon sink
          ? <Ionicons name="wallet-outline" size={22} color={colors.textSecondary} />
          : <ChainLogo chain="stellar-testnet" size={24} />}
      </View>
      <View className="flex-1">
        <Text className="font-pp-medium text-[15px] text-text">
          {isMetaMask ? 'MetaMask' : wallet.isDevBurner ? 'Stellar test key' : 'Freighter'}
        </Text>
        <Text className="font-pp-regular text-[12px] text-text-secondary">
          {isMetaMask ? 'Stellar mainnet only' : available ? 'Stellar Testnet' : 'Get Freighter for Stellar Testnet'}
        </Text>
        {failure ? <Text className="font-pp-regular text-[12px] text-[#E11D48]">{failure}</Text> : null}
      </View>
      {/* nw-keep(data-color): glyph color is a theme token into the vector-icon sink */}
      <Ionicons name={isMetaMask || available ? 'chevron-forward' : 'open-outline'} size={16} color={colors.textSecondary} />
    </Pressable>
  );
}
