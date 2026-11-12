import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Text } from 'react-native';
import { ChainRow, RegistrationCardFrame } from '@/components/home/registration-card-frame';

import { usePoolSession } from '@/hooks/use-pool-session';
import { useKeystoreRegistrationModal } from '@/components/keystore-registration-modal-provider';
import { useReceiveSetup } from '@/hooks/use-receive-setup';
import { useActiveEvmChain } from '@/hooks/use-active-evm-chain';
import {
  getReceiveSetup,
  receiveSetupFromIdentity,
  setReceiveSetup,
  type ReceiveSetupState,
} from '@/services/receive-setup';
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
    <RegistrationCardFrame
      expanded={expanded}
      onToggle={toggle}
      summary={summary}
      partialCount={partialCount}
      partial={partialCount > 0 || activePartial}
      warning={partialCount > 0 || activePartial || activeMismatch}
      notice={activeMismatch ? <AccountUnlockNotice network={getChainConfig(activeChainId)?.displayName ?? 'this network'} /> : null}
    >
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
    </RegistrationCardFrame>
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
