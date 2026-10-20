/**
 * Chain selector — lets users switch between EVM and Sui networks.
 *
 * Shows available chains and highlights the active one.
 * EVM chains use wagmi wallet connection, Sui uses dapp-kit.
 */
import React, { useState, useCallback } from 'react';
import { View, Text, Pressable } from 'react-native';
import { supportedChainIds, getChainConfig, type ChainConfig } from '@/config/chains';
import { useMultiChainWallet } from '@/hooks/use-multi-chain-wallet';

interface ChainSelectorProps {
  onChainSelect?: (chainId: number) => void;
}

export function ChainSelector({ onChainSelect }: ChainSelectorProps) {
  const wallet = useMultiChainWallet();
  const [selectedChainId, setSelectedChainId] = useState(wallet.chainId ?? supportedChainIds[0]);

  const chains = supportedChainIds
    .map(id => getChainConfig(id))
    .filter((c): c is ChainConfig => c !== undefined);

  const handleSelect = useCallback((chainId: number) => {
    setSelectedChainId(chainId);
    onChainSelect?.(chainId);
  }, [onChainSelect]);

  return (
    <View className="flex-row gap-[8px] py-[8px]">
      {chains.map(chain => {
        const isActive = chain.id === selectedChainId;
        const isConnected = wallet.isConnected && wallet.chainId === chain.id;

        return (
          <Pressable
            key={chain.id}
            className={`flex-row items-center gap-[6px] rounded-inner border px-[12px] py-[6px] ${
              isActive ? 'border-[#7c3aed] bg-[rgba(124,58,237,0.1)]' : 'border-[#333]'
            }`}
            onPress={() => handleSelect(chain.id)}
          >
            <Text
              className={`font-pp-regular text-[13px] ${isActive ? 'text-[#7c3aed]' : 'text-[#999]'}`}
            >
              {chain.displayName}
            </Text>
            {isConnected && (
              <View className="h-[6px] w-[6px] rounded-[3px] bg-[#22c55e]" />
            )}
          </Pressable>
        );
      })}
    </View>
  );
}
