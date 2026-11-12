import { getChainConfig } from '@/config/chains';
import { LEGACY_CONFIG } from '@/config/env';
import { alreadySetRegistrationRefusal, awaitKeystoreRegistries, readRegistryView } from '@/services/nullifying-key-hash-cache';

/** The keystore a chain's sessions and registry reads are scoped to. */
export function keystoreScopeAddress(chainId: number): string | undefined {
  return LEGACY_CONFIG?.keystore ?? getChainConfig(chainId)?.contracts?.keystoreAddress;
}

/**
 * The check every caller of `prepareRegisterKeystore()` runs before it treats
 * an "already registered" (or viewing-key-only) result as this session's own
 * registration. Local only: it compares the hash the SDK's own check just read.
 */
export function ownRegistrationResultRefusal(
  chainId: number,
  account: string | null | undefined,
  registration: { alreadyRegistered: boolean; keystoreCalldata: unknown; nullifyingKeyHash: unknown },
): string | null {
  // No account: nothing was read for it, so the result is unconfirmed.
  return alreadySetRegistrationRefusal(chainId, account ?? '', keystoreScopeAddress(chainId), registration);
}

export type OwnViewingKey =
  | { state: 'registered'; viewingKey: string }
  | { state: 'unregistered' }
  /** No current registry data: neither registered nor unregistered. */
  | { state: 'unknown' };

/** One per-account chain read of the viewing key (the pre-registry read). */
export type ChainViewingKeyReader = (chainId: number, account: string) => Promise<string | null | undefined>;

async function readViewingKeyFromChain(chainId: number, account: string): Promise<string | null | undefined> {
  const cfg = getChainConfig(chainId);
  if (!cfg?.contracts) throw new Error(`Unsupported chain: ${chainId}`);
  const sdkSetup = await import('@/services/sdk-runtime');
  const rpc = sdkSetup.createRPCInteractor(chainId, Number(cfg.contracts.fromBlock));
  const ks = sdkSetup.createKeystoreInteractor(rpc, (keystoreScopeAddress(chainId) ?? cfg.contracts.keystoreAddress) as never, cfg.contracts.keystoreFromBlock);
  return (await ks.getViewingKey(account as never)) as string | null | undefined;
}

/**
 * This session account's published viewing key, from the bulk viewing-key
 * registry (and our own confirmed registration record), asked FIRST: while the
 * registry answers, the account never reaches the RPC. A missing registry is
 * 'unknown', never 'unregistered': the caller must not offer "register" on a
 * guess. With `chainFallback`, 'unknown' (and only 'unknown') is answered by
 * the chain read this check made before the registries existed, with no wait.
 * A failed chain read throws, it never becomes 'unregistered'.
 */
export async function lookupOwnViewingKey(
  chainId: number,
  account: string,
  opts: { waitMs?: number; chainFallback?: boolean; /** Test seam. */ readChain?: ChainViewingKeyReader } = {},
): Promise<OwnViewingKey> {
  const keystore = keystoreScopeAddress(chainId);
  if (opts.waitMs && opts.waitMs > 0) await awaitKeystoreRegistries(chainId, keystore, opts.waitMs);
  const view = readRegistryView(chainId, account, keystore);
  if (view.viewingFresh) {
    if (!view.viewingKey || /^0x0*$/i.test(view.viewingKey)) return { state: 'unregistered' };
    return { state: 'registered', viewingKey: view.viewingKey };
  }
  if (!opts.chainFallback) return { state: 'unknown' };
  const onChain = await (opts.readChain ?? readViewingKeyFromChain)(chainId, account);
  if (!onChain || /^0x0*$/i.test(onChain)) return { state: 'unregistered' };
  return { state: 'registered', viewingKey: onChain };
}
