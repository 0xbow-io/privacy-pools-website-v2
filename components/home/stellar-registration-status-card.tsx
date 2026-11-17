import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Text } from 'react-native';
import { ChainRow, RegistrationCardFrame } from '@/components/home/registration-card-frame';
import { STELLAR_TESTNET_ID } from '@/config/chains';
import { useStellarWallet } from '@/components/stellar-wallet-provider';
import { stellarAccount } from '@/services/stellar/stellar-account';
import { StellarRegistrationCancelledError } from '@/services/stellar/stellar-registration-prompt';
import { stellarErrorMessage } from '@/services/stellar/stellar-copy';

export function StellarRegistrationStatusCard() {
  const wallet = useStellarWallet();
  return <StellarAccountRegistration key={`${wallet.address}:${wallet.networkPassphrase}:${wallet.isConnected}`} />;
}

function StellarAccountRegistration() {
  const wallet = useStellarWallet();
  const snapshot = useSyncExternalStore(stellarAccount.subscribe, stellarAccount.getSnapshot, stellarAccount.getSnapshot);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const lifetime = useRef({ active: true });
  useEffect(() => {
    const scope = lifetime.current;
    scope.active = true;
    return () => { scope.active = false; };
  }, []);
  const keysReady = wallet.isConnected && snapshot.address === wallet.address && snapshot.unlocked;
  const state = keysReady ? snapshot.registrationStatus : undefined;
  const canRegister = keysReady && !wallet.networkMismatch;
  const run = useCallback(async (register: boolean) => {
    if (busy.current || !keysReady || (register && !canRegister)) return;
    const scope = lifetime.current;
    busy.current = true;
    setLoading(true);
    setError(null);
    try {
      if (register) await stellarAccount.ensureCanReceive({ shouldContinue: () => scope.active });
      else await stellarAccount.checkRegistration();
    } catch (caught) {
      if (scope.active && register && !(caught instanceof StellarRegistrationCancelledError)) {
        setError(stellarErrorMessage(caught instanceof Error ? caught.message : String(caught)));
      }
    } finally {
      if (scope.active) { busy.current = false; setLoading(false); }
    }
  }, [keysReady, canRegister]);
  // Opening the card authorizes the read, including when unlock/binding finishes
  // after it opens. A settled answer (including a failed check) never auto-polls.
  useEffect(() => {
    if (!expanded || !keysReady || state !== undefined || loading) return;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) void run(false);
    });
    return () => { cancelled = true; };
  }, [expanded, keysReady, state, loading, run]);
  const register = () => { void run(true); };
  const check = () => { void run(false); };
  const toggle = () => setExpanded(!expanded);
  const partial = state === 'partial';
  const summary = state && state !== 'unknown' ? `${state === 'compatible' ? 1 : 0} of 1` : null;
  return (
    <RegistrationCardFrame expanded={expanded} onToggle={toggle} summary={summary} partial={partial} partialCount={partial ? 1 : 0} warning={partial}>
      {!keysReady ? (
        <Text className="py-[8px] font-pp-sans text-[13px] text-text-muted">
          Unlock your account to see where you&apos;re registered.
        </Text>
      ) : (
        <ChainRow chainId={STELLAR_TESTNET_ID} state={state} loading={loading || state === undefined} canRegister={canRegister} onRegister={register} onFinish={register} onRetry={check} />
      )}
      {error && <Text accessibilityRole="alert" className="font-pp-sans text-[12px] text-warning">{error}</Text>}
    </RegistrationCardFrame>
  );
}
