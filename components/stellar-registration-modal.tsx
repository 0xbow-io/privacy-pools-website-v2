import React, { useLayoutEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { RegistrationModalFrame, REGISTRATION_TITLE, REGISTRATION_BODY, REGISTRATION_PRIMARY } from '@/components/ui/registration-modal-frame';
import { useStellarWallet } from '@/components/stellar-wallet-provider';
import { useChainRouter } from '@/hooks/use-chain-router';
import { FINISH_SETUP_TITLE, FINISH_SETUP_BODY, FINISH_SETUP_PRIMARY } from '@/services/receive-setup';
import { describeStellarStage, stellarErrorMessage } from '@/services/stellar/stellar-copy';
import { stellarRegistrationPrompts, type StellarRegistrationPrompt } from '@/services/stellar/stellar-registration-prompt';

export function StellarRegistrationModal() {
  const wallet = useStellarWallet();
  const { isStellar, activeChainId } = useChainRouter();
  const [prompt, setPrompt] = useState<StellarRegistrationPrompt | null>(null);
  const { address, isConnected, networkMismatch, networkPassphrase } = wallet;
  useLayoutEffect(() => stellarRegistrationPrompts.attach(setPrompt, (owner) =>
    isStellar && isConnected && !networkMismatch && address === owner,
  ), [address, isConnected, networkMismatch, networkPassphrase, isStellar, activeChainId]);
  const visible = !!prompt && isStellar && wallet.isConnected && !wallet.networkMismatch && prompt.address === wallet.address;
  const pending = !!prompt?.pending;
  const finish = !!prompt?.finish;
  return (
    <RegistrationModalFrame visible={visible} title={finish ? FINISH_SETUP_TITLE : REGISTRATION_TITLE} onClose={stellarRegistrationPrompts.cancel}>
      <Text className="font-pp-regular text-[13px] leading-[19px] text-text-secondary">
        {finish ? FINISH_SETUP_BODY : REGISTRATION_BODY}
      </Text>
      {prompt?.error && (
        <View className="rounded-control border border-[#E11D48] px-[12px] py-[10px]">
          <Text className="font-pp-medium text-[12px] leading-[17px] text-[#E11D48]">{stellarErrorMessage(prompt.error)}</Text>
        </View>
      )}
      {pending && <Text className="font-pp-regular text-[12px] leading-[18px] text-text-secondary">{describeStellarStage('registering')}</Text>}
      {pending && <Text className="font-pp-medium text-[13px] leading-[18px] text-text">Check your wallet</Text>}
      <View className="mt-[6px] flex-row gap-[10px]">
        <Pressable accessibilityRole="button" onPress={stellarRegistrationPrompts.cancel} className="items-center justify-center rounded-control border border-border-light px-[16px] py-[12px]">
          <Text className="font-pp-medium text-[14px] text-text">{pending ? 'Close' : finish ? 'Remind me later' : 'Not now'}</Text>
        </Pressable>
        <Pressable testID="stellar-register-primary" accessibilityRole="button" disabled={pending} onPress={stellarRegistrationPrompts.approve} className={`flex-1 items-center justify-center rounded-control bg-button-primary py-[12px] ${pending ? 'opacity-60' : 'opacity-100'}`}>
          <Text className="font-pp-semi-bold text-[14px] text-button-primary-text">{pending ? (finish ? 'Finishing…' : 'Registering…') : finish ? FINISH_SETUP_PRIMARY : REGISTRATION_PRIMARY}</Text>
        </Pressable>
      </View>
    </RegistrationModalFrame>
  );
}
