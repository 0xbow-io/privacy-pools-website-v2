/**
 * Registration transactions this wallet sent whose receipt the modal never saw
 * (receipt-wait timeout, dropped RPC). Kept at module level, per owner + chain,
 * so closing and reopening the registration modal cannot clear it and let the
 * user send a duplicate while the first one may still mine.
 *
 * Privacy: the receipt poll is on a hash OUR OWN WALLET broadcast from this
 * client, never a relayed hash, so it names nothing the RPC did not already
 * receive from this client (docs/privacy-request-discipline.md).
 */

export type PendingRegistrationOutcome = 'success' | 'reverted' | 'unknown';

type Entry = { hash: string; startedAt: number };

/** How long a sent registration may block a resend before we give up waiting. */
export const PENDING_REGISTRATION_CAP_MS = 15 * 60_000;

const store = new Map<string, Entry>();
const listeners = new Set<() => void>();

const keyOf = (owner: string | null | undefined, chainId: number | null | undefined) =>
  `${(owner ?? '').toLowerCase()}:${chainId ?? ''}`;

const notify = () => { for (const l of listeners) l(); };

export function getPendingRegistration(
  owner: string | null | undefined,
  chainId: number | null | undefined,
  now = Date.now(),
): Entry | null {
  const entry = store.get(keyOf(owner, chainId));
  if (!entry) return null;
  if (now - entry.startedAt >= PENDING_REGISTRATION_CAP_MS) {
    store.delete(keyOf(owner, chainId));
    return null;
  }
  return entry;
}

export function subscribePendingRegistration(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Records a sent, unconfirmed registration tx and keeps waiting for its
 * receipt (up to the cap). Resolves with how it ended; the entry is cleared
 * on any terminal outcome, which re-enables Register.
 */
export async function trackPendingRegistration(
  owner: string | null | undefined,
  chainId: number | null | undefined,
  hash: string,
  waitForReceipt: (hash: string, timeoutMs: number) => Promise<'success' | 'reverted'>,
  now = Date.now(),
): Promise<PendingRegistrationOutcome> {
  const key = keyOf(owner, chainId);
  const entry: Entry = { hash, startedAt: now };
  store.set(key, entry);
  notify();
  let outcome: PendingRegistrationOutcome;
  try {
    outcome = await waitForReceipt(hash, PENDING_REGISTRATION_CAP_MS);
  } catch {
    outcome = 'unknown';
  }
  // A newer send for the same key owns the slot now.
  if (store.get(key) === entry) {
    store.delete(key);
    notify();
  }
  return outcome;
}

/** Test hook. */
export function resetPendingRegistrations(): void {
  store.clear();
  notify();
}
