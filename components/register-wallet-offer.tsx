import React from 'react';
import { Pressable, Text, View } from 'react-native';

import { getChainConfig } from '@/config/chains';
import { formatGasTopUp } from '@/services/gas-top-up';
import { REGISTER_OFFER_DONE, REGISTER_OFFER_TITLE, registerOfferBody } from '@/services/register-offer-copy';

/** The offer's gas estimate in the native coin of the chain it registers on. */
export function registerOfferGasText(offer: { gasCostWei: bigint; chainId: number } | null): string | null {
  if (!offer) return null;
  const native = getChainConfig(offer.chainId)?.nativeCurrency;
  if (!native) return null;
  return formatGasTopUp({ wei: offer.gasCostWei, symbol: native.symbol, decimals: native.decimals })?.amountText ?? null;
}

/**
 * Beside a claim refused as too small for the fee, when the wallet holds gas
 * (DEV-493): register now, so future payments arrive directly. Shared by the
 * claim page and the import modal; the state lives in useNoteImport.
 */
export function RegisterWalletOffer({
  offered,
  state,
  gasText,
  onRegister,
  onDismiss,
}: {
  offered: boolean;
  state: { status: 'idle' | 'registering' | 'registered' | 'error'; error?: string };
  gasText: string | null;
  onRegister: () => void;
  onDismiss: () => void;
}) {
  if (state.status === 'registered') {
    return (
      <View className="gap-[4px] rounded-control border border-border bg-success-bg px-[14px] py-[12px]" testID="register-offer-done">
        <Text className="font-pp-regular text-[12px] leading-[18px] text-success">{REGISTER_OFFER_DONE}</Text>
      </View>
    );
  }
  if (!offered) return null;
  const registering = state.status === 'registering';
  return (
    <View className="gap-[8px] rounded-control border border-border bg-background-secondary px-[14px] py-[12px]" testID="register-offer">
      <Text className="font-pp-semi-bold text-[13px] text-text">{REGISTER_OFFER_TITLE}</Text>
      <Text className="font-pp-regular text-[12px] leading-[18px] text-text-secondary">{registerOfferBody(gasText)}</Text>
      {state.status === 'error' && state.error ? (
        <Text className="font-pp-regular text-[12px] leading-[18px] text-danger">{state.error}</Text>
      ) : null}
      <View className="flex-row gap-[8px]">
        <Pressable
          className={`items-center justify-center rounded-control bg-button-primary px-[16px] py-[10px] ${registering ? 'opacity-50' : ''}`}
          disabled={registering}
          onPress={onRegister}
          accessibilityRole="button"
          testID="register-offer-register"
        >
          <Text className="font-pp-semi-bold text-[13px] text-button-primary-text">{registering ? 'Registering…' : 'Register'}</Text>
        </Pressable>
        <Pressable
          className={`items-center justify-center rounded-control border border-border px-[16px] py-[10px] ${registering ? 'opacity-50' : ''}`}
          disabled={registering}
          onPress={onDismiss}
          accessibilityRole="button"
          testID="register-offer-dismiss"
        >
          <Text className="font-pp-regular text-[13px] text-text">Not now</Text>
        </Pressable>
      </View>
    </View>
  );
}
