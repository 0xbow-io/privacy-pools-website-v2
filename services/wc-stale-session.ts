// A WalletConnect session left over from an earlier attempt that never reached
// wagmi makes the connector skip pairing, so it never emits display_uri.
export async function dropStaleWcSession(connector: { getProvider: () => Promise<unknown> }): Promise<void> {
  try {
    const provider = (await connector.getProvider()) as { session?: unknown; disconnect?: () => Promise<void> } | undefined;
    if (provider?.session && typeof provider.disconnect === 'function') await provider.disconnect();
  } catch {
    // Best effort: a failed cleanup must not block the connect.
  }
}
