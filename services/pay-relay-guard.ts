import {
  isConfirmedRevert,
  isKnownRejection,
  isRelayerOutOfGas,
  isRelayerRateLimited,
  isRelayerRefusal,
  isRelayerUnreachable,
} from '@/services/transfer-outcome';

// "Pay via Private Transfer" on /pay, and what may happen around its relay.
//
// DEV-486 (Mike, prod Ethereum, 2026-09-29): the relay call hung for 10+
// minutes, the run ended with the Pay buttons live again under a stale
// "Submitting via relayer..." box, and a second press started a SECOND payment.
// Three rules follow, kept here with tests rather than inline in the provider:
//   1. the relay wait is bounded;
//   2. a relay whose outcome is unknown latches the request, so the same
//      request cannot be paid again while the first one may still land;
//   3. "Leave payment" says what is actually running.

/** How long the pay flow waits on the relayer before it stops and says so. */
export const PAY_RELAY_DEADLINE_MS = 120_000;

/**
 * How long an unknown relay blocks paying the same request again. A relay the
 * relayer answered with a hash can sit in the mempool for a long time, so it
 * holds as long as relayed hashes are remembered elsewhere (one hour). One that
 * never answered can only land while its fee commitment is valid, which is far
 * shorter.
 */
export const PAY_RELAY_LATCH_MS = { heard: 60 * 60 * 1000, unheard: 10 * 60 * 1000 } as const;

/** Where a pay run is, for the Leave copy and the latch. */
export type PayRunPhase = 'idle' | 'wallet' | 'preparing' | 'relaying' | 'handed-over';

export class PayRelayDeadlineError extends Error {
  constructor() {
    super('Pay relay deadline passed');
    this.name = 'PayRelayDeadlineError';
  }
}

/** Rejects with PayRelayDeadlineError after `ms`. The relay itself keeps running. */
export function withRelayDeadline<T>(work: Promise<T>, ms: number = PAY_RELAY_DEADLINE_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PayRelayDeadlineError()), ms);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * True when a failed pay run may still have paid. Only a relay that was
 * handed over can be unknown, and every relayer answer that means "not sent"
 * is excluded by name.
 */
export function isPayRelayIndeterminate(message: string, relayAttempted: boolean): boolean {
  if (!relayAttempted) return false;
  return !isKnownRejection(message)
    && !isConfirmedRevert(message)
    && !isRelayerRefusal(message)
    && !isRelayerOutOfGas(message)
    && !isRelayerRateLimited(message)
    && !isRelayerUnreachable(message);
}

type Latch = { until: number; heard: boolean };
const latched = new Map<string, Latch>();
const listeners = new Set<() => void>();

const keyOf = (requestKey: string) => requestKey.toLowerCase();
const notify = () => { for (const l of listeners) l(); };

// The latch outlives a reload and is shared with other tabs: a page reloaded
// mid-relay must not offer the same request again. Device-local only (the
// request key is already in this browser's paid-request records). Storage
// can be missing or refuse; the in-memory map still holds for this page.
const STORAGE_KEY = 'ppv2:pay-relay-latches';
type LatchStorage = { getItem(k: string): string | null; setItem(k: string, v: string): void };
function storage(): LatchStorage | null {
  try {
    const s = (globalThis as { localStorage?: LatchStorage }).localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}
function loadStored(now: number): void {
  const s = storage();
  if (!s) return;
  try {
    const parsed = JSON.parse(s.getItem(STORAGE_KEY) ?? '{}') as Record<string, Latch>;
    for (const [k, v] of Object.entries(parsed)) {
      if (v && typeof v.until === 'number' && v.until > now) latched.set(k, { until: v.until, heard: !!v.heard });
    }
  } catch { /* a corrupt entry only costs the cross-tab copy */ }
}
// Merged into what storage holds now, never a replace: another tab may have
// latched a request this tab has not heard about yet, and a stale snapshot
// must not unblock it. Only `removed` (this tab's own release) is deleted.
function persist(now: number, removed?: string): void {
  const s = storage();
  if (!s) return;
  try {
    let stored: Record<string, Latch> = {};
    try { stored = JSON.parse(s.getItem(STORAGE_KEY) ?? '{}') as Record<string, Latch>; } catch { stored = {}; }
    for (const [k, v] of latched) {
      const prev = stored[k];
      stored[k] = prev && typeof prev.until === 'number'
        ? { until: Math.max(prev.until, v.until), heard: !!prev.heard || v.heard }
        : v;
    }
    if (removed) delete stored[removed];
    const live: Record<string, Latch> = {};
    for (const [k, v] of Object.entries(stored)) if (v && typeof v.until === 'number' && v.until > now) live[k] = v;
    s.setItem(STORAGE_KEY, JSON.stringify(live));
  } catch { /* storage refused: the in-memory latch still holds */ }
}
let loaded = false;
function ensureLoaded(now: number): void {
  if (loaded) return;
  loaded = true;
  loadStored(now);
  try {
    const w = globalThis as { addEventListener?: (t: string, fn: (e: { key?: string | null }) => void) => void };
    w.addEventListener?.('storage', (e) => {
      if (e.key !== STORAGE_KEY) return;
      latched.clear();
      loadStored(Date.now());
      notify();
    });
  } catch { /* no window: tests, native */ }
}

/** Blocks paying `requestKey` again until the latch window passes. */
export function latchPayRelay(requestKey: string, heard: boolean, now: number = Date.now()): void {
  ensureLoaded(now);
  const prev = latched.get(keyOf(requestKey));
  const until = now + (heard ? PAY_RELAY_LATCH_MS.heard : PAY_RELAY_LATCH_MS.unheard);
  latched.set(keyOf(requestKey), { until: Math.max(until, prev?.until ?? 0), heard: heard || !!prev?.heard });
  persist(now);
  notify();
}

/** The live latch for `requestKey`, or null. `until` is when it lapses. */
export function payRelayLatch(requestKey: string | null | undefined, now: number = Date.now()): { heard: boolean; until: number } | null {
  if (!requestKey) return null;
  ensureLoaded(now);
  const entry = latched.get(keyOf(requestKey));
  if (!entry) return null;
  if (now >= entry.until) {
    latched.delete(keyOf(requestKey));
    persist(now);
    return null;
  }
  return { heard: entry.heard, until: entry.until };
}

/** The payment settled (landed or provably not sent): the request is free again. */
export function releasePayRelay(requestKey: string): void {
  ensureLoaded(Date.now());
  const removed = latched.delete(keyOf(requestKey));
  // Removed from storage even when this tab never held it: the release is
  // this payment's own settled outcome.
  persist(Date.now(), keyOf(requestKey));
  if (removed) notify();
}

export function onPayRelayLatchChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test seam: forgets memory only; set `reload` to re-read storage next call. */
export function forgetPayRelayLatches(reload = false): void {
  latched.clear();
  if (reload) loaded = false;
}

/**
 * Shown when the relay wait runs out, and on a press while latched. Without a
 * hash the outcome is unknown, not "nothing sent": the request may have
 * reached the relayer and its answer been lost.
 */
export function payRelayUnknownMessage(heard: boolean): string {
  return heard
    ? 'The relayer accepted this payment and it may still land. Check your activity before paying again.'
    : "The relayer hasn't confirmed this payment. It may still land, so check your activity before paying again.";
}

/**
 * What the first "Leave payment" press says, or null when leaving is free.
 *
 * A private-transfer payment never asks the wallet for anything, so the old
 * wallet copy was wrong for it (DEV-486). Before the relay starts nothing can
 * have been sent, so leaving cancels it outright.
 */
export function leavePaymentWarning(phase: PayRunPhase): string | null {
  switch (phase) {
    case 'wallet':
      return 'This payment is still running in your wallet. Finish or reject it there first. Closing now would abandon a payment you have already started paying for. Press close again to leave anyway.';
    case 'relaying':
      return 'This payment is waiting on the relayer, which has not confirmed it yet. Leaving will not stop it, so check your activity before paying again. Press close again to leave.';
    case 'handed-over':
      return 'The relayer accepted this payment and it may still land. Check your activity before paying again. Press close again to leave.';
    default:
      return null;
  }
}

/** The footer button label while a run is busy. */
export function leavePaymentLabel(phase: PayRunPhase): string {
  return phase === 'preparing' ? 'Cancel payment' : 'Leave payment';
}
