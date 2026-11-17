import React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '@/components/theme-provider';
import { Colors } from '@/constants/theme';
import { ChainLogo, chainLogoChainFor } from '@/components/ui/chain-logo';
import { getChainConfig } from '@/config/chains';
import type { KeystoreIdentityStatus } from '@/components/sdk-provider';
import { FINISH_SETUP_PRIMARY, PARTIAL_STATE_LABEL } from '@/services/receive-setup';

export function RegistrationCardFrame({ expanded, onToggle, summary, partialCount = 0, partial = false, warning = false, notice, children }: {
  expanded: boolean;
  onToggle: () => void;
  summary: string | null;
  partialCount?: number;
  partial?: boolean;
  warning?: boolean;
  notice?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  return (
    <View testID="registration-status-card" className={`w-full overflow-hidden rounded-card border bg-background-secondary ${warning ? 'border-warning' : 'border-border-light'}`}>
      {notice}
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`Chain registration${summary ? `, registered on ${summary} chains` : ''}`}
        testID="registration-status-toggle"
        className="flex-row items-center gap-[10px] px-[16px] py-[12px]"
      >
        {/* nw-keep(data-color): header glyph colour is a theme token into the vector-icon sink */}
        <Ionicons
          name={partial ? 'alert-circle-outline' : 'key-outline'}
          size={16}
          color={partial ? colors.warning : colors.textSecondary}
        />
        <Text className="min-w-0 flex-1 font-pp-sans-medium text-[14px] text-text">Chain registration</Text>
        {partialCount > 0 ? (
          <Text className="font-pp-sans-medium text-[12px] text-warning">
            Setup incomplete on {partialCount}
          </Text>
        ) : summary ? (
          <Text className="font-pp-sans text-[12px] text-text-muted">Registered on {summary}</Text>
        ) : null}
        {/* nw-keep(data-color): chevron colour is a theme token into the vector-icon sink */}
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textSecondary} />
      </Pressable>

      {expanded ? (
        <View className="gap-[4px] border-t border-border-light px-[16px] pb-[14px] pt-[12px]">
          <Text className="pb-[6px] font-pp-sans text-[12px] leading-[17px] text-text-secondary">
            You register once per chain. Until you do, you can receive there but can&apos;t spend or exit.
          </Text>
          {children}
        </View>
      ) : null}
    </View>
  );
}

export function ChainRow({
  chainId,
  state,
  loading,
  canRegister,
  onRegister,
  onFinish,
  onRetry,
}: {
  chainId: number;
  state: KeystoreIdentityStatus | undefined;
  loading: boolean;
  canRegister: boolean;
  onRegister: (chainId: number) => void;
  onFinish: (chainId: number) => void;
  onRetry: (chainId: number) => void;
}) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const name = getChainConfig(chainId)?.displayName ?? `Chain ${chainId}`;
  return (
    <View testID={`registration-row-${chainId}`} className="flex-row items-center gap-[10px] py-[8px]">
      <ChainLogo chain={chainLogoChainFor(chainId)} size={22} />
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="font-pp-sans-medium text-[14px] text-text">{name}</Text>
        {state === 'incompatible' ? (
          <Text className="font-pp-sans text-[12px] leading-[16px] text-text-muted">
            Use your original wallet or passkey to access this account.
          </Text>
        ) : state === 'partial' ? (
          <Text className="font-pp-sans text-[12px] leading-[16px] text-warning">
            {PARTIAL_STATE_LABEL}
          </Text>
        ) : null}
      </View>
      {loading ? (
        <ActivityIndicator size="small" />
      ) : state === undefined ? (
        // Unread: a read names this address to that chain's RPC.
        <Pressable
          onPress={() => onRetry(chainId)}
          accessibilityRole="button"
          accessibilityLabel={`Check registration on ${name}`}
          testID={`registration-check-${chainId}`}
          className="flex-row items-center gap-[4px] rounded-pill border border-border px-[12px] py-[5px]"
        >
          <Text className="font-pp-sans text-[13px] text-text-secondary">Check</Text>
        </Pressable>
      ) : state === 'compatible' ? (
        <View className="flex-row items-center gap-[4px]">
          {/* nw-keep(data-color): status glyph uses the success theme token */}
          <Ionicons name="checkmark-circle" size={15} color={colors.success} />
          <Text className="font-pp-sans-medium text-[13px] text-success">Registered</Text>
        </View>
      ) : state === 'partial' ? (
        canRegister ? (
          <Pressable
            onPress={() => onFinish(chainId)}
            accessibilityRole="button"
            accessibilityLabel={`Finish setup on ${name}`}
            testID={`registration-finish-${chainId}`}
            className="rounded-pill bg-button-primary px-[14px] py-[6px] active:bg-button-primary-pressed"
          >
            <Text className="font-pp-sans-semi-bold text-[13px] text-button-primary-text">{FINISH_SETUP_PRIMARY}</Text>
          </Pressable>
        ) : (
          <View className="flex-row items-center gap-[4px]">
            {/* nw-keep(data-color): status glyph uses the warning theme token */}
            <Ionicons name="alert-circle" size={15} color={colors.warning} />
            <Text className="font-pp-sans-medium text-[13px] text-warning">Setup incomplete</Text>
          </View>
        )
      ) : state === 'incompatible' ? (
        <View className="flex-row items-center gap-[4px]">
          {/* nw-keep(data-color): status glyph uses the warning theme token */}
          <Ionicons name="alert-circle" size={15} color={colors.warning} />
          <Text className="font-pp-sans-medium text-[13px] text-warning">Different unlock</Text>
        </View>
      ) : state === 'unregistered' ? (
        <View className="flex-row items-center gap-[10px]">
          <Text className="font-pp-sans text-[13px] text-text-muted">Not registered</Text>
          {canRegister ? (
            <Pressable
              onPress={() => onRegister(chainId)}
              accessibilityRole="button"
              accessibilityLabel={`Register on ${name}`}
              testID={`registration-register-${chainId}`}
              className="rounded-pill bg-button-primary px-[14px] py-[6px] active:bg-button-primary-pressed"
            >
              <Text className="font-pp-sans-semi-bold text-[13px] text-button-primary-text">Register</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <Pressable
          onPress={() => onRetry(chainId)}
          accessibilityRole="button"
          accessibilityLabel={`Check ${name} again`}
          className="flex-row items-center gap-[4px] rounded-pill border border-border px-[12px] py-[5px]"
        >
          <Text className="font-pp-sans text-[13px] text-text-secondary">Couldn&apos;t check · Retry</Text>
        </Pressable>
      )}
    </View>
  );
}
