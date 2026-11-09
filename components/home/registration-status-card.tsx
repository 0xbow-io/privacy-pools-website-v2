import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '@/components/theme-provider';
import { Colors } from '@/constants/theme';
import { usePoolSession } from '@/hooks/use-pool-session';
import { useKeystoreRegistrationModal } from '@/components/keystore-registration-modal-provider';
import { useReceiveSetup } from '@/hooks/use-receive-setup';
import { useActiveEvmChain } from '@/hooks/use-active-evm-chain';
import {
  FINISH_SETUP_PRIMARY,
  getReceiveSetup,
  PARTIAL_STATE_LABEL,
  receiveSetupFromIdentity,
  setReceiveSetup,
  type ReceiveSetupState,
} from '@/services/receive-setup';
import { ChainLogo, chainLogoChainFor } from '@/components/ui/chain-logo';
import { getChainConfig, supportedEvmChainIds } from '@/config/chains';
import type { KeystoreIdentityStatus } from '@/components/sdk-provider';
import { receiveSetupVersion, subscribeReceiveSetup } from '@/services/receive-setup';
import { rowStatus } from '@/services/registration-rows';
import { useChainRouter } from '@/hooks/use-chain-router';
import { AccountUnlockNotice } from '@/components/account-unlock-help';

// Registration, per chain, made visible.
//
// An account is registered on a CHAIN, not once: each chain runs its own
// keystore, and until an address registers there it can receive on that chain
// but can neither spend nor exit (Ragequit proves keystore membership too).
// Nothing in the app said so. The registration modal only ever appeared as a
// prerequisite inside some other flow, on whichever chain that flow ran, so a
// user who had registered on one chain had no way to learn they were not
// registered on the others until a spend there failed.
//
// Collapsed by default, and it reads nothing until it is opened: each check
// is a keystore read that names this address to that chain's RPC, and three of
// them on every page load is disclosure nobody asked for.
//
// Both halves are existing machinery. The status is the same four-way read the
// deposit guard makes (sdk-provider's keystoreStatusForChain), which is what
// lets 'incompatible' be told apart from 'unregistered'. The Register button
// opens the ordinary registration modal with a targetChainId, which switches
// only the WALLET for the one transaction and builds the calldata against that
// chain's keystore.
//
// Auth policy set without a viewing key is its own state: the account can spend
// but can't receive privately. When the active chain is in it the card opens
// itself without reading anything; other chains are only read on a press.

/** EVM keystore registration only: Sui and Stellar register inside their own flows. */
export function RegistrationStatusCard() {
  const { isSui, isStellar } = useChainRouter();
  if (isSui || isStellar) return null;
  return <EvmRegistrationStatusCard />;
}

function EvmRegistrationStatusCard() {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { keysReady, identityMode, sessionAddress, keystoreStatusForChain } = usePoolSession();
  const { openKeystoreRegistrationModal, openFinishSetup } = useKeystoreRegistrationModal();
  const activeChainId = useActiveEvmChain().id;
  const { state: activeReceive, partial: activePartial } = useReceiveSetup();
  const activeMismatch = keysReady && activeReceive === 'incompatible';

  const [expanded, setExpanded] = useState(false);

  // Answers belong to one identity. The cache carries the identity it was read
  // for, and a render for any other identity sees it as empty, so a wallet or
  // unlock switch never shows the previous account's registrations under the
  // new one. A chain with no answer is unread, not loading; see `inFlight`.
  const identityKey = `${sessionAddress ?? ''}:${identityMode}:${keysReady}`;
  const [cache, setCache] = useState<{ key: string; states: Record<number, KeystoreIdentityStatus> }>({ key: '', states: {} });
  const [inFlight, setInFlight] = useState<{ key: string; ids: readonly number[] }>({ key: '', ids: [] });
  const loadingIds = useMemo(() => (inFlight.key === identityKey ? inFlight.ids : []), [inFlight, identityKey]);

  // The active chain's row is seeded from the session's load-time read.
  // DEV-440: a registration that lands after its modal was closed writes the
  // store, never this cache. Watch the store for every chain, and let an answer
  // further along than the cached read win (services/registration-rows.ts).
  const storeVersion = useSyncExternalStore(subscribeReceiveSetup, receiveSetupVersion, receiveSetupVersion);
  const states = useMemo(() => {
    const read = cache.key === identityKey ? cache.states : {};
    const seeded = identityStatusFromReceive(activeReceive);
    const base: Record<number, KeystoreIdentityStatus> = seeded && read[activeChainId] === undefined ? { ...read, [activeChainId]: seeded } : { ...read };
    if (!keysReady) return base;
    for (const id of supportedEvmChainIds) {
      const next = rowStatus(base[id], identityStatusFromReceive(getReceiveSetup(sessionAddress, id)));
      if (next !== undefined) base[id] = next;
    }
    return base;
  // storeVersion: re-derive when any chain's stored answer changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache, identityKey, activeReceive, activeChainId, keysReady, sessionAddress, storeVersion]);

  // Read by in-flight answers only, never during render: an answer for an
  // identity that is no longer current is dropped.
  const latestIdentity = useRef(identityKey);
  useEffect(() => { latestIdentity.current = identityKey; }, [identityKey]);

  // Opening the card by hand consents to reading every chain, per identity.
  const consentedFor = useRef<string | null>(null);

  const read = useCallback(async (chainIds: readonly number[], key: string) => {
    setInFlight((prev) => ({
      key,
      ids: [...new Set([...(prev.key === key ? prev.ids : []), ...chainIds])],
    }));
    await Promise.all(chainIds.map(async (id) => {
      const answer = await keystoreStatusForChain(id);
      if (latestIdentity.current !== key) return;
      // The store refuses a lagging read after a confirmed viewing key; the row follows it.
      const accepted = setReceiveSetup(sessionAddress, id, receiveSetupFromIdentity(answer), 'onchain');
      const status = accepted ? answer : identityStatusFromReceive(getReceiveSetup(sessionAddress, id)) ?? answer;
      setCache((prev) => (prev.key === key
        ? { key, states: { ...prev.states, [id]: status } }
        : { key, states: { [id]: status } }));
      setInFlight((prev) => (prev.key === key ? { key, ids: prev.ids.filter((x) => x !== id) } : prev));
    }));
  }, [keystoreStatusForChain, sessionAddress]);

  // One chain again (Check, Retry, or after registering there): drop its
  // answer, then read it.
  const recheck = useCallback((chainId: number) => {
    setCache((prev) => {
      if (prev.key !== identityKey) return prev;
      const { [chainId]: _dropped, ...rest } = prev.states;
      return { key: prev.key, states: rest };
    });
    void read([chainId], identityKey);
  }, [identityKey, read]);

  // A new identity while the card is open reads again, only with consent.
  // Opening the card has its own trigger in `toggle`.
  useEffect(() => {
    if (expanded && keysReady && cache.key !== identityKey && consentedFor.current === identityKey) {
      void read(supportedEvmChainIds, identityKey);
    }
    // Only an identity change should re-read here. `expanded` and the cache
    // are read, not watched: re-reading on every collapse or every answer
    // would defeat the cache.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityKey]);

  // Opens once per identity while the active chain is partial; reads nothing.
  const autoExpandedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!activePartial || !keysReady || autoExpandedFor.current === identityKey) return;
    autoExpandedFor.current = identityKey;
    setExpanded(true);
  }, [activePartial, keysReady, identityKey]);

  const toggle = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    // Reads only chains without an answer; a row that failed keeps its own Retry.
    if (next && keysReady) {
      consentedFor.current = identityKey;
      const answered = cache.key === identityKey ? cache.states : {};
      const unread = supportedEvmChainIds.filter((id) => answered[id] === undefined && !loadingIds.includes(id));
      if (unread.length > 0) void read(unread, identityKey);
    }
  }, [expanded, keysReady, cache, read, identityKey, loadingIds]);

  const register = useCallback((chainId: number) => {
    const name = getChainConfig(chainId)?.displayName ?? `chain ${chainId}`;
    openKeystoreRegistrationModal({
      targetChainId: chainId,
      // Gasless stays on offer: the hook registers on this target, and refuses
      // (with its own copy) when the target is not the live session's chain.
      title: `Register on ${name}`,
      body: `Registration is per chain. This onchain transaction sets up your account on ${name}, so you can spend, exit and get paid privately there.`,
      primaryLabel: `Register on ${name}`,
      onSuccess: () => recheck(chainId),
    });
  }, [openKeystoreRegistrationModal, recheck]);

  const finish = useCallback((chainId: number) => {
    openFinishSetup({
      targetChainId: chainId,
      onSuccess: () => recheck(chainId),
      // A relay may have landed even if the last step was skipped.
      onCancel: () => recheck(chainId),
    });
  }, [openFinishSetup, recheck]);

  const known = supportedEvmChainIds.filter((id) => states[id] && states[id] !== 'unknown');
  const registeredCount = supportedEvmChainIds.filter((id) => states[id] === 'compatible').length;
  const partialCount = supportedEvmChainIds.filter((id) => states[id] === 'partial').length;
  // A count only once every chain has answered: "1 of 3" while two are still
  // loading reads as a verdict.
  const summary = known.length === supportedEvmChainIds.length
    ? `${registeredCount} of ${supportedEvmChainIds.length}`
    : null;
  const canRegister = identityMode === 'wallet';

  return (
    <View
      testID="registration-status-card"
      className={`w-full overflow-hidden rounded-card border bg-background-secondary ${partialCount > 0 || activePartial || activeMismatch ? 'border-warning' : 'border-border-light'}`}
    >
      {activeMismatch ? (
        <AccountUnlockNotice network={getChainConfig(activeChainId)?.displayName ?? 'this network'} />
      ) : null}
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`Chain registration${summary ? `, registered on ${summary} chains` : ''}`}
        testID="registration-status-toggle"
        className="flex-row items-center gap-[10px] px-[16px] py-[12px]"
      >
        {/* nw-keep(data-color): header glyph colour is a theme token into the vector-icon sink */}
        <Ionicons
          name={partialCount > 0 || activePartial ? 'alert-circle-outline' : 'key-outline'}
          size={16}
          color={partialCount > 0 || activePartial ? colors.warning : colors.textSecondary}
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
          {!keysReady ? (
            <Text className="py-[8px] font-pp-sans text-[13px] text-text-muted">
              Unlock your account to see where you&apos;re registered.
            </Text>
          ) : (
            supportedEvmChainIds.map((chainId) => (
              <ChainRow
                key={chainId}
                chainId={chainId}
                state={states[chainId]}
                loading={loadingIds.includes(chainId)}
                canRegister={canRegister}
                onRegister={register}
                onFinish={finish}
                onRetry={recheck}
                successColor={colors.success}
                warningColor={colors.warning}
              />
            ))
          )}
          {keysReady && !canRegister ? (
            <Text className="pt-[6px] font-pp-sans text-[12px] leading-[17px] text-text-muted">
              {partialCount > 0
                ? 'To finish setup, sign out of the account key and connect the owner wallet. Publishing a viewing key needs a wallet transaction.'
                : 'To register, sign out of the account key and connect the owner wallet.'}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function identityStatusFromReceive(state: ReceiveSetupState): KeystoreIdentityStatus | null {
  switch (state) {
    case 'complete': return 'compatible';
    case 'partial': return 'partial';
    case 'unregistered': return 'unregistered';
    case 'incompatible': return 'incompatible';
    default: return null;
  }
}

function ChainRow({
  chainId,
  state,
  loading,
  canRegister,
  onRegister,
  onFinish,
  onRetry,
  successColor,
  warningColor,
}: {
  chainId: number;
  state: KeystoreIdentityStatus | undefined;
  loading: boolean;
  canRegister: boolean;
  onRegister: (chainId: number) => void;
  onFinish: (chainId: number) => void;
  onRetry: (chainId: number) => void;
  successColor: string;
  warningColor: string;
}) {
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
          <Ionicons name="checkmark-circle" size={15} color={successColor} />
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
            <Ionicons name="alert-circle" size={15} color={warningColor} />
            <Text className="font-pp-sans-medium text-[13px] text-warning">Setup incomplete</Text>
          </View>
        )
      ) : state === 'incompatible' ? (
        <View className="flex-row items-center gap-[4px]">
          {/* nw-keep(data-color): status glyph uses the warning theme token */}
          <Ionicons name="alert-circle" size={15} color={warningColor} />
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
