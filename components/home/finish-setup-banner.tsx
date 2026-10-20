import React, { useEffect, useRef } from 'react';
import { Pressable, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '@/components/theme-provider';
import { Colors } from '@/constants/theme';
import { useKeystoreRegistrationModal } from '@/components/keystore-registration-modal-provider';
import { useReceiveSetup } from '@/hooks/use-receive-setup';
import { usePoolSession } from '@/hooks/use-pool-session';
import { useActiveEvmChain } from '@/hooks/use-active-evm-chain';
import { getChainConfig } from '@/config/chains';
import {
  FINISH_SETUP_BANNER,
  FINISH_SETUP_PRIMARY,
  joinChainNames,
  takeFinishSetupAutoOpen,
} from '@/services/receive-setup';

// Not dismissible: it clears only when the chain reads a viewing key.
// Auto-opens only for an account that arrived partial; a chain that turns
// partial on this page belongs to the flow that did it, and opening over that
// flow's modal would drop its last step. Other chains are never read from here.

export function FinishSetupBanner() {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const activeChainId = useActiveEvmChain().id;
  const { state: activeState, partial: activePartial, partialChains, canFinish } = useReceiveSetup();
  const { sessionAddress } = usePoolSession();
  const { openFinishSetup, isOpen: registrationOpen } = useKeystoreRegistrationModal();

  // Active chain first: no wallet chain switch needed.
  const chains = activePartial
    ? [activeChainId, ...partialChains.filter((id) => id !== activeChainId)]
    : partialChains;
  const target = chains[0];

  const identityKey = `${sessionAddress?.toLowerCase() ?? ''}:${activeChainId}`;
  const firstSeen = useRef<{ key: string; state: string } | null>(null);
  if (activeState !== 'unknown' && firstSeen.current?.key !== identityKey) {
    firstSeen.current = { key: identityKey, state: activeState };
  }
  const arrivedPartial = firstSeen.current?.key === identityKey && firstSeen.current.state === 'partial';

  const autoOpenedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!activePartial || !arrivedPartial || !canFinish || registrationOpen) return;
    if (autoOpenedFor.current === identityKey) return;
    autoOpenedFor.current = identityKey;
    if (takeFinishSetupAutoOpen()) openFinishSetup({ targetChainId: activeChainId });
  }, [activePartial, arrivedPartial, canFinish, registrationOpen, identityKey, activeChainId, openFinishSetup]);

  if (!canFinish || chains.length === 0 || target === undefined) return null;
  const names = chains.map((id) => getChainConfig(id)?.displayName ?? `chain ${id}`);

  return (
    <View
      testID="finish-setup-banner"
      accessibilityRole="alert"
      className="flex-row items-center gap-[10px] rounded-inner border border-warning bg-warning-bg px-[12px] py-[10px]"
    >
      {/* nw-keep(data-color): warning glyph color is a theme token into the @expo/vector-icons sink (no className path) */}
      <Ionicons name="alert-circle-outline" size={16} color={colors.warning} />
      <View className="min-w-0 flex-1 gap-[2px]">
        <Text className="font-pp-regular text-[12px] leading-[17px] text-text">{FINISH_SETUP_BANNER}</Text>
        {chains.length > 1 ? (
          <Text className="font-pp-sans-medium text-[12px] leading-[17px] text-warning">
            Setup incomplete on {joinChainNames(names)}.
          </Text>
        ) : null}
      </View>
      <Pressable
        className="rounded-control bg-button-primary px-[14px] py-[6px]"
        accessibilityRole="button"
        accessibilityLabel={`Finish setup on ${names[0]}`}
        testID="finish-setup-banner-cta"
        onPress={() => openFinishSetup({ targetChainId: target })}
      >
        <Text className="font-pp-semi-bold text-[12px] text-button-primary-text">{FINISH_SETUP_PRIMARY}</Text>
      </Pressable>
    </View>
  );
}
