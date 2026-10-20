// The Privacy Pools account is derived from the wallet's EIP-712 signature (its
// r value, SDK deriveKeysFromSignature). That only works when the wallet returns
// the SAME signature for the same payload every time (RFC 6979 deterministic
// nonces). Two wallet classes break it:
//   - contract wallets (Safe, Ambire, ...) answer with EIP-1271 data, not one
//     secp256k1 signature: the SDK refuses them with "must be 65 bytes";
//   - signers with a random nonce (some MPC / HSM / hardware wallets) return a
//     well-formed 65-byte signature that differs each time, so every sign-in
//     silently derives a fresh, empty account.
// MetaMask and Rabby are known RFC 6979 signers and skip the proof (Pat,
// 2026-09-05: a second prompt is too annoying to impose on everyone); every other
// wallet proves determinism once with a second signature.

export type ContractWalletVerdict = 'eoa' | 'delegated-eoa' | 'contract';

/**
 * Classifies the code at the signing address. An EIP-7702 delegation
 * (0xef0100 || address) still signs with the EOA's own key and passes.
 */
export function contractWalletVerdict(code: string | null | undefined): ContractWalletVerdict {
  if (!code || code === '0x') return 'eoa';
  if (code.toLowerCase().startsWith('0xef0100')) return 'delegated-eoa';
  return 'contract';
}

export type SignerIdentity = {
  /** wagmi connector id: an EIP-6963 rdns ("io.metamask") or "injected". */
  id?: string | null;
  /** wagmi connector name ("MetaMask", "Rabby Wallet"). */
  name?: string | null;
  /** EIP-1193 provider flags, when the connector exposes its provider. */
  flags?: { isMetaMask?: unknown; isRabby?: unknown } | null;
};

/** True for MetaMask and Rabby, the wallets trusted to sign deterministically. */
export function isKnownDeterministicSigner(identity: SignerIdentity): boolean {
  const id = (identity.id ?? '').toLowerCase();
  const name = (identity.name ?? '').toLowerCase();
  if (id === 'io.metamask' || id === 'io.rabby') return true;
  if (name.includes('rabby')) return true;
  if (name === 'metamask' || name.startsWith('metamask ')) return true;
  // isRabby is set by Rabby alone. isMetaMask is a self-reported compatibility
  // flag that many wallets set, so it grants nothing: a non-deterministic
  // wallet wearing it would skip the only proof (codex on 4548cd2).
  if (identity.flags?.isRabby === true) return true;
  return false;
}

type ConnectorLike = {
  id?: string;
  name?: string;
  getProvider?: () => Promise<unknown>;
};

/** Reads the connector's identity (id, name, provider flags) and classifies it. */
export async function connectorIsKnownDeterministicSigner(connector: ConnectorLike | null | undefined): Promise<boolean> {
  if (!connector) return false;
  let flags: SignerIdentity['flags'] = null;
  try {
    const provider = await connector.getProvider?.();
    if (provider && typeof provider === 'object') {
      const p = provider as { isMetaMask?: unknown; isRabby?: unknown };
      flags = { isMetaMask: p.isMetaMask, isRabby: p.isRabby };
    }
  } catch {
    flags = null;
  }
  return isKnownDeterministicSigner({ id: connector.id, name: connector.name, flags });
}

export const SMART_WALLET_SIGNIN_MESSAGE =
  'This address is a smart-contract wallet (Safe, Ambire or similar). It signs in with a passkey, which is turned off in this build. Connect the owner wallet directly, or sign in with an account key.';

export const NON_DETERMINISTIC_SIGNER_MESSAGE =
  'This wallet returned two different signatures for the same message, so it cannot derive a stable Privacy Pools account. Use MetaMask or Rabby, or sign in with an account key.';

/**
 * DEV-427 (mobile): the Coinbase Wallet app is now the Base app, whose default
 * account is a Coinbase Smart Wallet. Until its first transaction that account
 * has no code, so the getCode probe calls it an EOA and the app asks it for the
 * derivation signature. The Base app cannot build that request (it shows
 * "Error generating message ... enough funds"), and even if it could it would
 * answer with ERC-1271/6492 data, never the 65-byte key signature the account is
 * derived from. Its EIP-5792 capabilities are what give it away: a smart account
 * reports `atomic: "supported"` (or the older `atomicBatch.supported`), while an
 * EOA that could be upgraded reports "ready" and still signs with its own key.
 */
export function capabilitiesSayContractAccount(
  capabilities: unknown,
  chainId: number,
  codeVerdict: ContractWalletVerdict | null,
): boolean {
  // Only an address with NO code on this chain (read successfully) can be an
  // undeployed smart wallet. A 7702-delegated EOA also reports "supported",
  // but it signs with its own key and must keep the wallet signature, and with
  // no verdict at all we cannot tell the two apart.
  if (codeVerdict !== 'eoa') return false;
  if (!capabilities || typeof capabilities !== 'object') return false;
  const all = capabilities as Record<string, unknown>;
  // Only the active chain: a delegation or smart account elsewhere says
  // nothing about the account that signs here.
  const perChain = all[`0x${chainId.toString(16)}`] ?? all[String(chainId)];
  if (!perChain || typeof perChain !== 'object') return false;
  const c = perChain as { atomic?: { status?: unknown }; atomicBatch?: { supported?: unknown } };
  return c.atomic?.status === 'supported' || c.atomicBatch?.supported === true;
}

/** A 65-byte secp256k1 signature, the only shape the derivation accepts. */
export function isPlainEcdsaSignature(signature: string): boolean {
  return /^0x[0-9a-fA-F]{130}$/.test(signature);
}

export const COINBASE_SMART_WALLET_SIGNIN_MESSAGE =
  'This Coinbase account is a smart wallet. It signs in with a passkey, which is turned off in this build. Use a Coinbase Wallet recovery phrase account, MetaMask or Rabby, or sign in with an account key.';

/**
 * Coinbase's EIP-7702 proxy (base/eip-7702-proxy, the same address on every
 * chain Coinbase Smart Wallet supports). An EOA delegated to it is run by the
 * Base / Coinbase app as a Coinbase Smart Wallet.
 */
export const COINBASE_7702_PROXY = '0x7702cb554e6bfb442cb743a7df23154544a7176c';

/** The delegate of an EIP-7702 delegated EOA (0xef0100 || address), or null. */
export function delegationTarget(code: string | null | undefined): string | null {
  const c = (code ?? '').toLowerCase();
  return /^0xef0100[0-9a-f]{40}$/.test(c) ? `0x${c.slice(8)}` : null;
}

/**
 * DEV-427: after the Coinbase app has FAILED to sign (v4 and the v3 retry), is
 * this an account the Base app runs as a Coinbase Smart Wallet? Then it never
 * had a signature-derived account in that app and the passkey is its unlock.
 * Never consulted before the wallet has tried to sign: the same 7702 EOA signs
 * fine in the Coinbase extension or MetaMask and keeps that account.
 *   - an EOA delegated to Coinbase's 7702 proxy on this chain, or
 *   - an address with no code on this chain that reports atomic "supported"
 *     for this chain (an undeployed Coinbase Smart Wallet).
 */
export function coinbasePasskeyFallbackApplies(p: {
  code: string | null | undefined;
  codeVerdict: ContractWalletVerdict | null;
  capabilities: unknown;
  chainId: number;
}): boolean {
  if (p.codeVerdict === 'delegated-eoa') return delegationTarget(p.code) === COINBASE_7702_PROXY;
  return capabilitiesSayContractAccount(p.capabilities, p.chainId, p.codeVerdict);
}
