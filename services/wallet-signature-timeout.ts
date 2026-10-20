/**
 * DEV-427: a per-signature bound on the wallet's sign-in prompt.
 *
 * Some wallets (the Coinbase Wallet extension, observed) open a popup that
 * never renders the request and never errors. The only bound used to be the
 * 120s session cap. This one is shorter and names the wallet, so the dialog
 * can say what happened and offer Sign in again.
 */

export const SIGNATURE_TIMEOUT_MS = 45_000;

export type SignatureStage = 'initial' | 'proof' | 'legacy';

export type WalletIdentity = {
  id?: string | null;
  name?: string | null;
  rdns?: string | readonly string[] | null;
  type?: string | null;
  peerName?: string | null;
  flags?: { isCoinbaseWallet?: unknown; isRabby?: unknown; isBraveWallet?: unknown; isPhantom?: unknown; isTrust?: unknown } | null;
};

export type WalletConnector = WalletIdentity & { getProvider?: () => Promise<unknown> };

// The Coinbase Wallet app is now the Base app; its WalletConnect peer metadata may name either.
const isBaseAppName = (name?: string | null) => /^base(?: app| wallet)?$/i.test(name?.trim() ?? '');
const isCoinbaseName = (name?: string | null) => isBaseAppName(name) || /^(coinbase(?: wallet)?(?: sdk)?|coinbasewallet)$/i.test(name?.trim() ?? '');
/** The name a timeout message uses: a Base app WalletConnect peer is named as the Base app. */
export function coinbaseWalletLabel(identity: WalletIdentity | null | undefined): string {
  return identity && isWalletConnect(identity) && isBaseAppName(identity.peerName) ? 'Base app' : 'Coinbase Wallet';
}
export const isWalletConnectConnector = (identity: WalletIdentity | null | undefined): boolean => !!identity && isWalletConnect(identity);
const isWalletConnect = (identity: WalletIdentity) =>
  identity.id?.toLowerCase() === 'walletconnect' || identity.type === 'walletConnect';

/** Explicit connector identity wins over injected compatibility flags. */
export function isCoinbaseWalletIdentity(identity: WalletIdentity | null | undefined): boolean {
  if (!identity) return false;
  const id = (identity.id ?? '').toLowerCase();
  if (isWalletConnect(identity)) return isCoinbaseName(identity.peerName);
  const rdns = typeof identity.rdns === 'string' ? [identity.rdns]
    : identity.rdns ?? (id.includes('.') ? [id] : []);
  if (rdns.length) return rdns.some((value) => ['com.coinbase.wallet', 'com.coinbase'].includes(value.toLowerCase()));
  if (id === 'coinbasewallet' || id === 'coinbasewalletsdk') return true;
  if (id && id !== 'injected') return false;
  if (isCoinbaseName(identity.name)) return true;
  if (identity.name && !/^(injected|browser wallet)$/i.test(identity.name.trim())) return false;
  const flags = identity.flags;
  // Coinbase itself can set isMetaMask. That compatibility flag is not an
  // identity, but flags identifying a different wallet must not opt it in.
  return flags?.isCoinbaseWallet === true && !flags.isRabby && !flags.isBraveWallet
    && !flags.isPhantom && !flags.isTrust;
}

export function signatureTimeoutMessage(walletName?: string | null): string {
  const wallet = walletName && walletName.trim() ? walletName.trim() : 'Your wallet';
  return `${wallet} did not answer the sign-in request. Open the wallet, close any stuck popup, then tap Sign in to try again.`;
}

export class SignatureTimeoutError extends Error {
  readonly stage: SignatureStage;
  constructor(stage: SignatureStage, walletName?: string | null) {
    super(signatureTimeoutMessage(walletName));
    this.name = 'SignatureTimeoutError';
    this.stage = stage;
  }
}

export function isSignatureTimeout(err: unknown): boolean {
  return err instanceof SignatureTimeoutError
    || (err instanceof Error && err.name === 'SignatureTimeoutError');
}

/**
 * Races the wallet's answer against the bound. The wallet promise itself
 * cannot be cancelled; a late answer is ignored.
 */
export function withSignatureTimeout<T>(
  sign: Promise<T>,
  opts: { stage: SignatureStage; walletName?: string | null; timeoutMs?: number | null; onTimeout?: () => void },
): Promise<T> {
  const timeoutMs = opts.timeoutMs === undefined ? SIGNATURE_TIMEOUT_MS : opts.timeoutMs;
  if (timeoutMs === null) return sign;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { opts.onTimeout?.(); } catch { /* diagnostics must not swallow the timeout */ }
      reject(new SignatureTimeoutError(opts.stage, opts.walletName));
    }, timeoutMs);
    sign.then(
      (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); },
      (e) => { if (settled) return; settled = true; clearTimeout(timer); reject(e); },
    );
  });
}

/** A bounded read of the already connected provider, or null (never throws). */
export async function walletProvider(connector: WalletConnector | null | undefined): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Connected providers are already held locally. A broken connector must
    // not strand identity detection or delay installing the signature timer.
    return await Promise.race([
      connector?.getProvider?.(),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 1_000); }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The wallet name a WalletConnect session reports, or null (never throws). */
export async function walletConnectPeerName(connector: WalletConnector | null | undefined): Promise<string | null> {
  const provider = await walletProvider(connector);
  try {
    const name = (provider as { session?: { peer?: { metadata?: { name?: unknown } } } } | null)
      ?.session?.peer?.metadata?.name;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch {
    // A throwing session/metadata getter is an unknown wallet, not a failure.
    return null;
  }
}

/** Read only the connected provider's local identity; never issue an RPC. */
export async function resolveWalletIdentity(connector: WalletConnector | null | undefined): Promise<WalletIdentity> {
  if (!connector) return {};
  if (isWalletConnect(connector)) {
    return { ...connector, peerName: await walletConnectPeerName(connector) };
  }
  if (connector.rdns || (connector.id && connector.id !== 'injected') || isCoinbaseWalletIdentity(connector)) {
    return connector;
  }
  const provider = await walletProvider(connector);
  try {
    const p = provider as Record<string, unknown> | null;
    // Copy the flags now so a throwing getter falls back to an unknown wallet.
    const flags = p ? { isCoinbaseWallet: p.isCoinbaseWallet, isRabby: p.isRabby, isBraveWallet: p.isBraveWallet, isPhantom: p.isPhantom, isTrust: p.isTrust } : null;
    return { ...connector, flags };
  } catch {
    return connector;
  }
}

/** Resolve identity before starting the request, then attach its timer immediately. */
export async function requestWalletSignature<T>(
  sign: () => Promise<T>,
  connector: WalletConnector | null | undefined,
  opts: { stage: SignatureStage; onPending?: (identity: WalletIdentity, timeoutMs: number | null) => void; onTimeout?: () => void },
): Promise<T> {
  const identity = await resolveWalletIdentity(connector);
  const timeoutMs = signatureTimeoutFor(identity);
  opts.onPending?.(identity, timeoutMs);
  return withSignatureTimeout(sign(), {
    stage: opts.stage,
    timeoutMs,
    walletName: isCoinbaseWalletIdentity(identity) ? coinbaseWalletLabel(identity) : identity.peerName ?? identity.name,
    onTimeout: opts.onTimeout,
  });
}

/**
 * The per-signature bound for a wallet, or null for none. Only Coinbase Wallet
 * gets the 45s bound: other wallets keep the user-paced 120s session cap.
 */
export function signatureTimeoutFor(identity: WalletIdentity | null | undefined): number | null {
  return isCoinbaseWalletIdentity(identity) ? SIGNATURE_TIMEOUT_MS : null;
}

/**
 * Asks the connected wallet itself (EIP-5792 wallet_getCapabilities) what the
 * account can do. Goes to the wallet only, never to an RPC or the ASP, and names
 * nothing but the address the wallet already holds. Bounded; null on any error
 * or on a wallet that does not implement it.
 */
export async function walletCapabilities(
  connector: WalletConnector | null | undefined,
  address: string,
  timeoutMs = 3_000,
): Promise<unknown> {
  const provider = await walletProvider(connector) as { request?: (a: { method: string; params?: unknown[] }) => Promise<unknown> } | null;
  if (!provider) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Inside the try: a throwing getter is an unknown wallet, not a failure.
    if (typeof provider.request !== 'function') return null;
    return await Promise.race([
      provider.request({ method: 'wallet_getCapabilities', params: [address] }),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
