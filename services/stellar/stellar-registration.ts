import type { StellarPoolSession } from './stellar-account';
import type { StellarRegistrationPrompt } from './stellar-registration-prompt';
type Registration = Awaited<ReturnType<StellarPoolSession['prepareRegisterKeystore']>>;

export function stellarRegistrationStatus(registration: Pick<Registration, 'alreadyRegistered' | 'keystoreCalldata' | 'viewingKeyCalldata'>): 'compatible' | 'partial' | 'unregistered' {
  if (registration.alreadyRegistered) return 'compatible';
  return !registration.keystoreCalldata || !registration.viewingKeyCalldata ? 'partial' : 'unregistered';
}

/** Runs within the caller's queue. Retry always prepares again, including partial setup. */
export async function registerStellarAccount({ session, address, assertActive, requestConsent, execute, onStatus, wait = () => new Promise<void>((resolve) => setTimeout(resolve, 2_000)) }: {
  session: Pick<StellarPoolSession, 'prepareRegisterKeystore'>;
  address: string;
  assertActive: () => void;
  requestConsent: (prompt: StellarRegistrationPrompt) => Promise<() => void>;
  execute: (registration: Registration, guard: () => void) => Promise<void>;
  onStatus?: (status: ReturnType<typeof stellarRegistrationStatus>) => void;
  wait?: () => Promise<void>;
}) {
  assertActive();
  let registration = await session.prepareRegisterKeystore();
  assertActive();
  onStatus?.(stellarRegistrationStatus(registration));
  if (registration.alreadyRegistered) return;
  let error: string | undefined;
  while (true) {
    const assertConsent = await requestConsent({
      address,
      finish: !registration.keystoreCalldata && !!registration.viewingKeyCalldata,
      error,
    });
    const guard = () => { assertActive(); assertConsent(); };
    guard();
    try {
      // Consent may take a while: rebuild only the still-missing legs.
      registration = await session.prepareRegisterKeystore();
      guard();
      onStatus?.(stellarRegistrationStatus(registration));
      if (!registration.alreadyRegistered) await execute(registration, guard);
      let confirmed = registration.alreadyRegistered;
      for (let attempt = 0; attempt < 10 && !confirmed; attempt++) {
        guard();
        try {
          registration = await session.prepareRegisterKeystore();
          confirmed = registration.alreadyRegistered;
        } catch {
          // Retry confirmation, never replay a transaction.
        }
        if (!confirmed) await wait();
      }
      guard();
      if (!confirmed) throw new Error('Your account registration has not shown up on chain yet. Try again in a minute.');
      onStatus?.('compatible');
      return;
    } catch (caught) {
      guard();
      error = caught instanceof Error ? caught.message : String(caught);
      // A prior leg may have landed. Re-read for Finish setup before asking
      // again; the next approval still re-prepares and never replays calldata.
      try { registration = await session.prepareRegisterKeystore(); } catch { /* Keep the last known steps. */ }
      guard();
      onStatus?.(stellarRegistrationStatus(registration));
      if (registration.alreadyRegistered) return;
    }
  }
}
