import { displayTokenSymbol } from '@/services/share-display';
import React, { useState } from 'react';
import { CloseIcon } from '@/components/ui/modal-icons';
import { View, Text, Pressable, Platform, TextInput, ScrollView, useWindowDimensions } from 'react-native';
import type { ViewStyle } from 'react-native';
import Svg, { Path, Circle } from 'react-native-svg';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { SUI_TESTNET_ID } from '@/config/chains';
import { ChainLogo, chainLogoChainFor } from '@/components/ui/chain-logo';
import { TokenNetworkIcon } from '@/components/ui/token-network-icon';
import { useBackHandler } from '@/hooks/use-back-handler';

// Shared two-pane "Select token / Select network" selector (CoW-style),
// extracted verbatim from the deposit modal (DEV-222) so the swap modal can
// reuse the exact same picker for its output token + destination network.
// Presentation-only: the owner keeps the token/network lists, the current
// selection, and open/close state; search state lives here and resets on
// every mount (the deposit modal reset it on open, which is equivalent since
// the owner conditionally renders this component).

// react-native-web supports position:'fixed', absent from RN's ViewStyle.
// Native has no 'fixed' — the overlay falls back to absolute full-screen so
// the selector still covers the viewport there.
interface WebOnlyViewStyle { position?: string }
const OVERLAY_POSITION: ViewStyle & WebOnlyViewStyle = Platform.OS === 'web'
  ? { position: 'fixed' } as ViewStyle & WebOnlyViewStyle
  : { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 };

export interface TokenNetworkSelectorToken {
  symbol: string;
  address: string;
  isNative?: boolean;
  /** Human name shown under the symbol (e.g. "USD Coin"). Falls back to
   * "Native" for native assets, else a truncated address. */
  name?: string;
}

export interface TokenNetworkSelectorNetwork {
  id: number;
  name: string;
}


function CheckCircleIcon({ color = '#00ACC4' }: { color?: string }) {
  return (
    // nw-keep(svg-or-canvas): stroke fed by the caller's color prop (selection check mark)
    <Svg width={48} height={48} viewBox="0 0 48 48" fill="none">
      <Circle cx={24} cy={24} r={23} stroke={color} strokeWidth={2} fill="none" />
      <Path d="M15 24L21 30L33 18" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}

export function TokenNetworkSelector({
  tokens,
  networks,
  selectedTokenSymbol,
  activeNetworkId,
  onSelectToken,
  onSelectNetwork,
  onClose,
  tokenTitle = 'Select token',
  networkTitle = 'Select network',
}: {
  tokens: TokenNetworkSelectorToken[];
  networks: TokenNetworkSelectorNetwork[];
  selectedTokenSymbol: string;
  activeNetworkId: number;
  onSelectToken: (token: TokenNetworkSelectorToken) => void;
  onSelectNetwork: (networkId: number) => void;
  onClose: () => void;
  tokenTitle?: string;
  networkTitle?: string;
}) {
  // Android back closes the picker instead of leaving the app.
  useBackHandler(true, onClose);
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { width } = useWindowDimensions();
  // Narrow screens (320-390px phones): the fixed 240px network pane would
  // squeeze the token pane into unusability — stack the panes vertically
  // instead, network pane capped so the token list keeps most of the height.
  const stacked = width < 560;
  const [tokenSearch, setTokenSearch] = useState('');
  const [networkSearch, setNetworkSearch] = useState('');

  const searchClass = 'mb-[8px] rounded-pill border border-border-light bg-background-secondary px-[14px] py-[9px] text-[13px] text-text';

  return (
    <View
      className="inset-0 z-[1000000] items-center justify-center bg-[rgba(0,0,0,0.5)] p-[20px]"
      // nw-keep(platform-css): position fixed on web / absolute full-screen on native (RN has no 'fixed')
      style={OVERLAY_POSITION}
    >
      <Pressable className="absolute inset-0" onPress={onClose} />
      <View className={`h-[600px] max-h-[90%] w-full max-w-[760px] overflow-hidden rounded-card border border-border bg-card-background ${stacked ? 'flex-col' : 'flex-row'}`}>
        {/* Left: token list */}
        <View className="flex-1 p-[16px]">
          <View className="mb-[10px] flex-row items-center justify-between">
            <Text className="font-pp-bold text-[16px] text-text">{tokenTitle}</Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <CloseIcon color={colors.text} />
            </Pressable>
          </View>
          <TextInput
            className={searchClass}
            placeholder="Search name or paste address…"
            // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
            placeholderTextColor={colors.textMuted}
            value={tokenSearch}
            onChangeText={setTokenSearch}
          />
          <ScrollView className="flex-1" keyboardShouldPersistTaps="handled">
            {tokens.filter((t) => {
              const q = tokenSearch.trim().toLowerCase();
              return !q
                || t.symbol.toLowerCase().includes(q)
                || t.address.toLowerCase().includes(q)
                || (t.name ?? '').toLowerCase().includes(q);
            }).map((token) => {
              const isSel = token.symbol === selectedTokenSymbol;
              return (
                <Pressable
                  key={token.symbol}
                  className={`flex-row items-center gap-[12px] rounded-control px-[8px] py-[10px] ${isSel ? 'bg-primary-soft' : ''}`}
                  onPress={() => onSelectToken(token)}
                >
                  <TokenNetworkIcon symbol={token.symbol} chainId={activeNetworkId} size={28} badgeSize={15} />
                  <View className="flex-1">
                    <Text className="font-pp-bold text-[15px] text-text">{displayTokenSymbol(token.symbol)}</Text>
                    <Text className="font-pp-regular text-[12px] text-text-muted">
                      {token.name ?? (token.isNative ? 'Native' : `${token.address.slice(0, 6)}…${token.address.slice(-4)}`)}
                    </Text>
                  </View>
                  {isSel ? <CheckCircleIcon color={colors.tint} /> : null}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
        {/* Right: network list (below the tokens when stacked) */}
        <View className={`border-l-border-light border-t-border-light p-[16px] ${stacked ? 'max-h-[190px] w-full border-l-0 border-t' : 'w-[240px] border-l'}`}>
          <Text className="mb-[10px] font-pp-bold text-[16px] text-text">{networkTitle}</Text>
          <TextInput
            className={searchClass}
            placeholder="Search network"
            // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
            placeholderTextColor={colors.textMuted}
            value={networkSearch}
            onChangeText={setNetworkSearch}
          />
          <ScrollView className="flex-1" keyboardShouldPersistTaps="handled">
            {networks.filter((n) => {
              const q = networkSearch.trim().toLowerCase();
              return !q || n.name.toLowerCase().includes(q);
            }).map((net) => {
              const isActive = net.id === activeNetworkId;
              return (
                <Pressable
                  key={net.id}
                  className={`flex-row items-center gap-[10px] rounded-control px-[8px] py-[12px] ${isActive ? 'bg-primary-soft' : ''}`}
                  onPress={() => onSelectNetwork(net.id)}
                >
                  <ChainLogo chain={chainLogoChainFor(net.id)} size={24} />
                  <Text className="flex-1 font-pp-regular text-[14px] text-text">{net.name}</Text>
                  {isActive ? <CheckCircleIcon color={colors.tint} /> : null}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </View>
  );
}
