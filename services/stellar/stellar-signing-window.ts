/**
 * The validity window of a Stellar transaction starts when the wallet is asked
 * to sign it, not when the SDK built it.
 *
 * The Stellar SDK builds every Soroban call with a 30 s window
 * (DEFAULT_TX_TIMEOUT_SECONDS) before the Freighter popup opens. The time a
 * person spends reading and approving the popup counts against it, and the
 * second keystore registration transaction (built together with the first)
 * also waits for the first one to confirm. Past the window the network refuses
 * the transaction with `txTooLate`. Nothing is sent then, so a retry is safe,
 * but on a first deposit it was easy to hit.
 *
 * Only the upper time bound moves, and only for an unsigned Soroban call that
 * already has one. The key derivation message (a manageData transaction with
 * no time bound) is never touched: the account keys are derived from its exact
 * signature.
 */
import type { StellarWalletProvider } from '@privacy-pools-v2/stellar-sdk';

/** From the moment the wallet is asked, the time left to approve and submit. */
export const STELLAR_SIGNING_WINDOW_SECONDS = 300;

/**
 * `unsignedXdr` with its upper time bound moved to `nowSeconds` plus the
 * signing window. Returned unchanged when it is not an unsigned Soroban call,
 * has no upper bound, or already allows longer.
 */
export async function refreshSigningWindow(unsignedXdr: string, nowSeconds: number): Promise<string> {
  const { xdr } = await import('@stellar/stellar-sdk');
  let envelope;
  try {
    envelope = xdr.TransactionEnvelope.fromXDR(unsignedXdr, 'base64');
  } catch {
    return unsignedXdr;
  }
  if (envelope.switch().name !== 'envelopeTypeTx') return unsignedXdr;
  const v1 = envelope.v1();
  if (v1.signatures().length > 0) return unsignedXdr;
  const tx = v1.tx();
  const operations = tx.operations();
  if (operations.length === 0 || !operations.every((op) => op.body().switch().name === 'invokeHostFunction')) {
    return unsignedXdr;
  }
  const cond = tx.cond();
  const kind = cond.switch().name;
  const bounds = kind === 'precondTime' ? cond.timeBounds() : kind === 'precondV2' ? cond.v2().timeBounds() : null;
  if (!bounds) return unsignedXdr;
  const current = BigInt(bounds.maxTime().toString());
  if (current === 0n) return unsignedXdr;
  const next = BigInt(Math.floor(nowSeconds) + STELLAR_SIGNING_WINDOW_SECONDS);
  if (next <= current) return unsignedXdr;
  bounds.maxTime(xdr.Uint64.fromString(next.toString()));
  return envelope.toXDR('base64');
}

/** The wallet signer, handing it each transaction with a fresh signing window. */
export function withSigningWindow(signer: StellarWalletProvider, now: () => number = Date.now): StellarWalletProvider {
  return {
    getAddress: () => signer.getAddress(),
    getNetworkPassphrase: () => signer.getNetworkPassphrase(),
    async signTransaction(unsignedXdr, opts) {
      const refreshed = await refreshSigningWindow(unsignedXdr, Math.floor(now() / 1000));
      return signer.signTransaction(refreshed, opts);
    },
  };
}
