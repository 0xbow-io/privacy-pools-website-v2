/**
 * "Pay from wallet" for a blind Stellar payment request (DEV-500).
 *
 * The same recipe as EVM's wallet-pay (services/payment-request-deposit.ts):
 * a public deposit from the payer's Freighter wallet bound to the request's
 * first note slot, with noteData tagged with the request tag and encrypted to
 * the request's payment key. The requester's session finds it with the same
 * scan that finds a private payment, so the link names no account and the
 * requester needs no published viewing key.
 *
 * Stellar difference: the precommitment and the note payload take the
 * FIELD-converted token id (StellarAddressFieldConverter.toTokenIdField), the
 * deposit itself takes the C... contract. A mismatch would make the note
 * unspendable, so both come from the same converter, and the SDK's own
 * prepareDepositFor recomputes the label from the depositSecret passed here.
 *
 * Pure module: services are injected, so it is bun-testable.
 */
import {
  buildPaymentRequestDepositNoteData,
  type NoteComputationLike,
} from '@/services/payment-request-deposit';
import type { StellarSdkPaymentRequestPayload } from '@/services/payment-request-codec';
import { STELLAR_XLM } from '@/config/stellar-deployment';
import { isStellarRequestExpired } from '@/services/stellar/stellar-request';

type Hex = `0x${string}`;

export interface StellarRequestDepositParams {
  tokenId: string;
  value: Hex;
  noteAddressHash: Hex;
  noteData: { hint: Hex; data: Hex };
  depositSecret: Hex;
}

export function buildStellarRequestDeposit(input: {
  request: StellarSdkPaymentRequestPayload;
  /** The deployment's native XLM contract: the only asset payable here. */
  nativeTokenId: string;
  tokenIdField: string;
  noteComputation: NoteComputationLike;
  depositSecret: string;
}): StellarRequestDepositParams {
  const { request } = input;
  if (request.tokenId !== input.nativeTokenId) throw new Error('This request is not for XLM.');
  const built = buildPaymentRequestDepositNoteData({
    request: {
      tokenId: input.tokenIdField,
      amount: request.amount,
      paymentPubKey: request.paymentPubKey,
      tag: request.tag,
      noteSecretsMap: request.noteSecretsMap,
    },
    noteComputation: input.noteComputation,
    depositSecret: input.depositSecret,
  });
  return {
    tokenId: request.tokenId,
    value: request.amount,
    noteAddressHash: built.noteAddressHash,
    noteData: built.noteData,
    depositSecret: built.depositSecret,
  };
}

/**
 * Wording for a Stellar submit that ran out of time. The SDK gives a
 * transaction 30 seconds of validity, and proving plus the Freighter prompt
 * can take longer. Only a submit refused as too late is known not to have
 * landed; a receipt wait that ran out is reported as unknown.
 */
export function stellarTimeoutMessage(raw: string): string | null {
  // Refused at submit for being past its validity: it never entered the ledger.
  if (/txTooLate|tx_too_late/i.test(raw)) return 'Transaction timed out. Nothing was sent. Try again.';
  // The receipt wait ran out. The tx was submitted and RPC ingestion can lag,
  // so it may still have landed (cubic on #304). An RPC call timeout is the
  // same unknown.
  if (/StellarTransactionTimedOut|StellarRPCCallTimedOut|timed out after/i.test(raw)) return STELLAR_TIMEOUT_UNKNOWN_MESSAGE;
  return null;
}

export const STELLAR_TIMEOUT_UNKNOWN_MESSAGE = 'Transaction timed out. It may still go through. Check your activity before trying again.';

/** A wallet deposit has the pool's 1 XLM floor; a private transfer does not. */
export const WALLET_MINIMUM_MESSAGE = `Wallet pay needs at least ${Number(STELLAR_XLM.minDeposit) / 10 ** STELLAR_XLM.decimals} XLM. Use Private Transfer for this request.`;

/** Re-checked right before signing: the requester stops scanning a lapsed request. */
export function assertStellarRequestLive(request: StellarSdkPaymentRequestPayload, now = Date.now()): void {
  if (isStellarRequestExpired(request, now)) throw new Error('PaymentRequestExpired: this payment request has expired.');
}
