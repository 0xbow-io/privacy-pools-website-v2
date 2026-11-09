// Fired after either bulk keystore registry (nullifying-key hashes, viewing
// keys) lands a successful grid sync. Lets a write that needs a current
// registry wait for the grid instead of asking anything itself.
type Listener = () => void;
const listeners = new Set<Listener>();

export function notifyRegistrySynced(): void {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // a listener's failure is its own
    }
  });
}

export function onRegistrySynced(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// A registration this client's own wallet or relayer just got CONFIRMED by a
// successful receipt (status success, never a sent-but-unconfirmed leg). The
// SDK provider mirrors it into the local registry state from the keys the
// session already holds, so register-then-deposit continues before the ASP
// has indexed it. No request: the values are our own.
export interface ConfirmedRegistration {
  address: string;
  chainId: number;
  /** The viewing-key leg was part of what the receipt confirmed. */
  viewingKey: boolean;
}

type ConfirmedListener = (event: ConfirmedRegistration) => void;
const confirmedListeners = new Set<ConfirmedListener>();

export function confirmedRegistration(address: string | null | undefined, chainId: number, viewingKey: boolean): void {
  if (!address) return;
  confirmedListeners.forEach((listener) => {
    try {
      listener({ address, chainId, viewingKey });
    } catch {
      // a listener's failure is its own
    }
  });
}

export function onConfirmedRegistration(listener: ConfirmedListener): () => void {
  confirmedListeners.add(listener);
  return () => {
    confirmedListeners.delete(listener);
  };
}
