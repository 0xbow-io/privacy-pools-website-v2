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
