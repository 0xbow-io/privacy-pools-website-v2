/**
 * Wallet-pay for SDK-native (v3) payment requests.
 *
 * Why this module exists
 * ----------------------
 * "Pay via Wallet" is an ordinary public `Entrypoint.deposit` via the SDK's
 * `prepareDepositFor`, so it needs no shielded balance. That is the ONLY path a
 * payer with an empty pool can use, which makes it the path that matters for a
 * first-time payer. It was switched off for SDK-native requests by a80b9e9
 * (2026-05-13) with a true reason at the time: `prepareDepositFor` emitted a
 * fresh random hint, and an SDK-native receiver discovers a payment by matching
 * a Note event's hint against `tag = Poseidon([paymentId])`. A deposit could not
 * carry that tag, so the money would land and the request would never close.
 *
 * Since then the SDK gained an escape hatch built for stealth delivery:
 * `DepositForParams` path A accepts a caller-built `noteData: {hint, data}` plus
 * a caller-supplied `depositSecret`. That is enough to emit a deposit whose Note
 * event carries the request's tag, which is what this module builds.
 *
 * The trap this module exists to avoid
 * ------------------------------------
 * The obvious re-enable is to pass the request's `paymentPubKey` as
 * `discoveryData.publicViewingKey`, mirroring the v2 branch. DO NOT. That emits
 * a note with a fresh random hint (missing the tag map) encrypted to a key that
 * is not the receiver's main viewing key (missing the catch-all scan), and the
 * payer-generated noteSecret is never handed over. Neither scan finds it and
 * nobody can spend it: the funds are permanently unrecoverable. The four
 * criteria a receiver's `scanPaymentRequests` matches on are hint/tag,
 * encryption key, payload kind, and slot binding, and the payload below is
 * built to satisfy all four.
 *
 * The recipe
 * ----------
 *   slot        = one of the request's pre-allocated noteAddressHash slots
 *   precommit   = computePrecommitment(slot, tokenId, value)
 *   label       = computeLabel(precommit, depositSecret)     <- needs OUR secret
 *   noteData    = generatePaymentRequestNoteData(payload, paymentPubKey, tag)
 *
 * `label` is why `depositSecret` must be ours: the payload has to name the
 * lineage, and the lineage is only determined once the deposit secret is fixed.
 * The SDK would otherwise generate that secret internally, after we have already
 * built (and committed to) the payload. Passing both keeps the submitted
 * noteData and the proof context in sync; a mismatch reverts on-chain with
 * PoolVault_ProofContextMismatch (safe, but a wasted gas fee).
 *
 * PURE module: no React, no SDK import, no network. Services are injected, so
 * this is testable under bun (importing sdk-setup pulls React Native and dies on
 * Flow types, the same reason config/relayer-eras.ts is shaped this way).
 */

export type HexString = `0x${string}`;

/** The fields of an SDK-native request this builder consumes. */
export interface SdkNativeRequestLike {
  tokenId: string;
  amount: string;
  /** Per-request ephemeral X25519 public key the payload is encrypted to. */
  paymentPubKey: string;
  /** Deterministic Poseidon([paymentId]); the receiver's O(1) discovery filter. */
  tag: string;
  /** Pre-allocated [noteAddressHash, noteSecret] slots. Secrets are placeholders
   *  in a shared link, and are deliberately NOT needed here. */
  noteSecretsMap: Array<[string, string]>;
}

/** The slice of the SDK's note-computation service this builder needs. */
export interface NoteComputationLike {
  computePrecommitment(noteAddressHash: string, tokenId: string, value: string): string;
  computeLabel(precommitment: string, depositSecret: string): string;
  generatePaymentRequestNoteData(
    payload: { noteAddressHash: string; value: string; tokenId: string; label: string },
    recipientViewingPubKey: string,
    hint?: string,
  ): { hint: string; data: string };
}

export interface DepositForNoteDataResult {
  noteAddressHash: HexString;
  noteData: { hint: HexString; data: HexString };
  depositSecret: HexString;
  /** Returned for logging/receipts: the lineage this deposit will create. */
  label: HexString;
}

/**
 * A deposit is ONE note in ONE lineage, so it consumes exactly one slot.
 *
 * The transfer path sizes its slot use by distinct input labels
 * (`recipientSlotCount` in the pay modal); a deposit has no inputs, so it always
 * takes the first. Taking the first (rather than a random one) also keeps two
 * attempts at the same request landing on the same slot, which is what makes a
 * retry after a reverted deposit idempotent from the receiver's side.
 */
export const DEPOSIT_SLOT_INDEX = 0;

export class PaymentRequestDepositError extends Error {}

/**
 * Build the `prepareDepositFor` path-A arguments that make a wallet deposit
 * discoverable as the fulfilment of an SDK-native payment request.
 *
 * `depositSecret` is injected rather than generated here so the caller owns
 * randomness (and so this is deterministic under test).
 */
export function buildPaymentRequestDepositNoteData(input: {
  request: SdkNativeRequestLike;
  noteComputation: NoteComputationLike;
  depositSecret: string;
}): DepositForNoteDataResult {
  const { request, noteComputation, depositSecret } = input;

  if (!request.noteSecretsMap || request.noteSecretsMap.length === 0) {
    // Without a slot the receiver has nothing to bind the payment to, and a
    // deposit against an invented hash would be unspendable by anyone.
    throw new PaymentRequestDepositError(
      'This payment request has no note slots, so it cannot be paid from a wallet. Ask the sender for a fresh link.',
    );
  }
  if (!request.tag) {
    throw new PaymentRequestDepositError(
      'This payment request carries no discovery tag, so a wallet payment could not be found by the recipient. Ask the sender for a fresh link.',
    );
  }
  if (!request.paymentPubKey) {
    throw new PaymentRequestDepositError(
      'This payment request carries no payment key, so a wallet payment could not be decrypted by the recipient. Ask the sender for a fresh link.',
    );
  }
  if (!depositSecret) {
    throw new PaymentRequestDepositError('Missing deposit secret for the payment deposit.');
  }

  const slot = request.noteSecretsMap[DEPOSIT_SLOT_INDEX];
  const noteAddressHash = slot && slot[0];
  if (!noteAddressHash) {
    throw new PaymentRequestDepositError(
      'This payment request has an empty note slot, so it cannot be paid from a wallet. Ask the sender for a fresh link.',
    );
  }

  const precommitment = noteComputation.computePrecommitment(
    noteAddressHash,
    request.tokenId,
    request.amount,
  );
  const label = noteComputation.computeLabel(precommitment, depositSecret);

  // hint = the request tag. This is the whole point: it is what puts the event
  // in the receiver's tag map instead of the catch-all pile.
  const noteData = noteComputation.generatePaymentRequestNoteData(
    { noteAddressHash, value: request.amount, tokenId: request.tokenId, label },
    request.paymentPubKey,
    request.tag,
  );

  if (!noteData || !noteData.hint || !noteData.data) {
    throw new PaymentRequestDepositError('Could not build the payment note payload. Nothing was sent.');
  }
  // Fail before broadcasting rather than after: a hint that is not the tag is
  // precisely the undiscoverable-payment bug this module exists to prevent, and
  // on-chain it is unrecoverable rather than merely wrong.
  if (noteData.hint.toLowerCase() !== request.tag.toLowerCase()) {
    throw new PaymentRequestDepositError(
      'The payment note was not tagged for this request, so the recipient could not find it. Nothing was sent.',
    );
  }

  return {
    noteAddressHash: noteAddressHash as HexString,
    noteData: { hint: noteData.hint as HexString, data: noteData.data as HexString },
    depositSecret: depositSecret as HexString,
    label: label as HexString,
  };
}
