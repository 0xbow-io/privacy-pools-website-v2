/**
 * DEV-427 (mobile): the Coinbase / Base app in-app browser fails our
 * key-derivation eth_signTypedData_v4 request with "Error generating message.
 * Please make sure you have enough funds", then answers 4001.
 *
 * The domain cannot change (it would change every user's keys). What can change
 * is the RPC method: for this payload (one flat struct of a string and a
 * bytes32, no arrays, no nested structs) eth_signTypedData_v3 and _v4 hash
 * identically by spec, so a v3 signature from the same key over the same
 * payload is the same signature and derives the same keys. A v3 answer is only
 * accepted if it recovers, locally, to the signing address.
 *
 * Every tap sends exactly ONE wallet request, inside the caller's timeout:
 *   1st tap: v4. If the Coinbase app fails it (a 4001 from the error sheet looks
 *   exactly like a real Cancel, so we cannot tell them apart), nothing is
 *   re-prompted; the user is told to tap Sign in again.
 *   next tap: v3. If that fails too, the caller may switch to the passkey.
 * A real Cancel therefore never triggers a second prompt by itself.
 * Every request goes to the connected wallet only, never to an RPC.
 */
import { getTypesForEIP712Domain, isAddressEqual, recoverTypedDataAddress, serializeTypedData, type Address, type Hex, type TypedDataDefinition } from 'viem';
import { isSignatureTimeout } from './wallet-signature-timeout';
import { isStaleConnectorError } from './stale-connector';
import { isWalletReconnectingError } from './wallet-reconnect';

export const COINBASE_V4_FAILED_MESSAGE =
  'Coinbase did not sign. If it showed "Error generating message", tap Sign in again to try another way.';

export const COINBASE_APP_CANNOT_SIGN_MESSAGE =
  'The Coinbase app cannot sign the Privacy Pools sign-in message yet. Open this page in MetaMask or Rabby, use the Coinbase Wallet browser extension, or sign in with an account key.';

type Requester = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };

/** The Coinbase / Base app's own in-app browser (not the extension, not WalletConnect). */
export function isCoinbaseInAppBrowser(env: { provider?: unknown; userAgent?: string | null }): boolean {
  let flag = false;
  try {
    flag = (env.provider as { isCoinbaseBrowser?: unknown } | null | undefined)?.isCoinbaseBrowser === true;
  } catch {
    flag = false;
  }
  return flag || /CoinbaseWallet|CoinbaseBrowser|CBWallet|BaseApp/i.test(env.userAgent ?? '');
}

/** True when the typed data has no arrays and no nested structs, so v3 and v4 hash the same. */
export function v3HashesLikeV4(types: Record<string, readonly { name: string; type: string }[]>): boolean {
  const structs = new Set(Object.keys(types));
  return Object.values(types).every((fields) =>
    fields.every((f) => !f.type.endsWith(']') && !structs.has(f.type)));
}

/** The Coinbase app failed (or the user cancelled) the v4 request. Nothing was re-prompted. */
export class CoinbaseV4FailedError extends Error {
  constructor() {
    super(COINBASE_V4_FAILED_MESSAGE);
    this.name = 'CoinbaseV4FailedError';
  }
}

/** The Coinbase app also failed the v3 request (or gave a signature that does not recover). */
export class CoinbaseAppCannotSignError extends Error {
  constructor() {
    super(COINBASE_APP_CANNOT_SIGN_MESSAGE);
    this.name = 'CoinbaseAppCannotSignError';
  }
}

export function isCoinbaseV4Failed(err: unknown): boolean {
  return err instanceof CoinbaseV4FailedError || (err instanceof Error && err.name === 'CoinbaseV4FailedError');
}

export function isCoinbaseAppCannotSign(err: unknown): boolean {
  return err instanceof CoinbaseAppCannotSignError || (err instanceof Error && err.name === 'CoinbaseAppCannotSignError');
}

/** One wallet request: v4 normally, v3 when the Coinbase app already failed v4 for this address. */
export async function signTypedDataWithCoinbaseFallback(params: {
  signV4: () => Promise<Hex>;
  coinbaseInApp: boolean;
  /** The Coinbase app already failed v4 for this address in this session. */
  useV3: boolean;
  provider: Requester | null;
  address: Address;
  typedData: TypedDataDefinition;
}): Promise<Hex> {
  if (params.coinbaseInApp && params.useV3) {
    const types = params.typedData.types as Record<string, readonly { name: string; type: string }[]>;
    if (!params.provider || !v3HashesLikeV4(types)) throw new CoinbaseAppCannotSignError();
    let signature: Hex;
    try {
      signature = await params.provider.request({
        method: 'eth_signTypedData_v3',
        // serializeTypedData drops the domain unless types names EIP712Domain
        // (viem adds it only inside its own v4 action), so add it explicitly.
        params: [params.address, serializeTypedData({
          ...params.typedData,
          types: { EIP712Domain: getTypesForEIP712Domain({ domain: params.typedData.domain }), ...params.typedData.types },
        } as unknown as TypedDataDefinition)],
      }) as Hex;
    } catch {
      throw new CoinbaseAppCannotSignError();
    }
    let recovered: Address | null = null;
    try {
      recovered = await recoverTypedDataAddress({ ...params.typedData, signature } as Parameters<typeof recoverTypedDataAddress>[0]);
    } catch {
      recovered = null;
    }
    if (!recovered || !isAddressEqual(recovered, params.address)) throw new CoinbaseAppCannotSignError();
    return signature;
  }
  try {
    return await params.signV4();
  } catch (v4Err) {
    // A timeout, a stale connector or a reconnect is not the Coinbase app refusing:
    // pass it through so the caller's own retry for it still matches.
    if (!params.coinbaseInApp || isSignatureTimeout(v4Err) || isWalletReconnectingError(v4Err)
      || isStaleConnectorError(v4Err instanceof Error ? v4Err.message : String(v4Err))) throw v4Err;
    throw new CoinbaseV4FailedError();
  }
}

export const COINBASE_CONFIRM_NEXT_TAP_MESSAGE =
  'Coinbase signed. Tap Sign in once more to confirm it.';

/**
 * The v3 sign-in signature was taken on this tap; its determinism proof needs a
 * second signature, which waits for the next tap (one wallet request per tap).
 */
export class CoinbaseConfirmNextTapError extends Error {
  constructor() {
    super(COINBASE_CONFIRM_NEXT_TAP_MESSAGE);
    this.name = 'CoinbaseConfirmNextTapError';
  }
}

export function isCoinbaseConfirmNextTap(err: unknown): boolean {
  return err instanceof CoinbaseConfirmNextTapError || (err instanceof Error && err.name === 'CoinbaseConfirmNextTapError');
}

/**
 * Determinism proof for the v3 path, spread over two taps. The first tap's
 * signature is kept; the next tap's signature is the proof. Only r feeds the
 * derivation, so only r has to repeat.
 *   'defer'    no earlier signature: keep this one, ask for the next tap
 *   'match'    same r as the earlier tap: proved, no further request
 *   'mismatch' different r: the wallet is not deterministic
 */
export function coinbaseTwoTapProof(previous: Hex | null | undefined, current: Hex): 'defer' | 'match' | 'mismatch' {
  if (!previous) return 'defer';
  return previous.slice(0, 66).toLowerCase() === current.slice(0, 66).toLowerCase() ? 'match' : 'mismatch';
}
