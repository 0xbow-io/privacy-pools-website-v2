import { useEffect, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';

const readFragment = () => (typeof window === 'undefined' ? undefined : window.location?.hash.slice(1) || undefined);

/**
 * The payload of a share link (/import-note, /receive, /pay, /verify). It rides
 * in the URL fragment, which browsers never send to the server, so opening a
 * link shows the host only the route. Links built before carry it as the
 * `[encoded]` path segment, which every open sent to the host.
 *
 * The fragment is read at mount, so a later URL rewrite cannot drop it, and on
 * `hashchange`, since opening another link in the same tab does not reload.
 */
export function useShareLinkPayload(): string | undefined {
  const params = useLocalSearchParams<{ encoded?: string | string[] }>();
  const fromPath = Array.isArray(params.encoded) ? params.encoded[0] : params.encoded;
  const [fromFragment, setFromFragment] = useState(readFragment);
  useEffect(() => {
    const onHashChange = () => setFromFragment((prev) => readFragment() ?? prev);
    window.addEventListener?.('hashchange', onHashChange);
    return () => window.removeEventListener?.('hashchange', onHashChange);
  }, []);
  return fromPath || fromFragment;
}
