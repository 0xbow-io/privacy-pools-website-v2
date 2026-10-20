/**
 * Sui wallet connect button.
 *
 * Uses @mysten/dapp-kit's ConnectButton or a custom implementation
 * that matches the app's design system.
 */
import React from 'react';
import { Text, Pressable } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useCurrentAccount, useDisconnectWallet, useConnectWallet, useWallets } from '@mysten/dapp-kit';
import { CopyIconButton } from '@/components/ui/copy-address';

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

const BUTTON_BASE = 'flex-row items-center gap-[6px] rounded-[8px] border px-[12px] py-[8px]';

export function SuiConnectButton() {
  const account = useCurrentAccount();
  const { mutate: disconnect } = useDisconnectWallet();
  const { mutate: connect } = useConnectWallet();
  const wallets = useWallets();

  if (account) {
    return (
      <Pressable
        className={`${BUTTON_BASE} border-border-light bg-card-background`}
        onPress={() => disconnect()}
      >
        {/* nw-keep(data-color): Sui brand blue into the icon color prop (non-class sink, not a theme token) */}
        <Ionicons name="water" size={14} color="#4DA2FF" />
        <Text className="font-pp-regular text-[13px] text-text">
          {truncateAddress(account.address)}
        </Text>
        <CopyIconButton value={account.address} />
      </Pressable>
    );
  }

  return (
    <Pressable
      className={`${BUTTON_BASE} border-[#4DA2FF] bg-[#4DA2FF]`}
      onPress={() => {
        // Connect to first available Sui wallet
        if (wallets.length > 0) {
          connect({ wallet: wallets[0] });
        }
      }}
    >
      {/* nw-keep(data-color): fixed white glyph on the brand-blue CTA (icon color prop, non-class sink) */}
      <Ionicons name="water-outline" size={14} color="#fff" />
      <Text className="font-pp-medium text-[13px] text-[#fff]">
        Connect Sui
      </Text>
    </Pressable>
  );
}
