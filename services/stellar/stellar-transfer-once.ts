/**
 * A relayed Stellar transfer that builds its zero-knowledge proof once (DEV-645), and the
 * one-time-link variant that goes through the relayer too (DEV-641).
 *
 * `session.prepareTransfer` / `prepareColdStartTransfer` run a full proof only to build the
 * self-submit `executeOptions`, and `session.relayTransfer` proves again with the relayer's fee
 * (vendored SDK: `PoolSessionTransfer.buildPrepareTransferResult` and `relayTransfer`). The relayed
 * path discards the first proof, so this asks the relayer for the committed quote directly (what
 * `prepare*` does before it proves) and hands `relayTransfer` the option it would have been given.
 *
 * Nothing here names a note in a request: the quote request carries the asset and the proof shape
 * (input and output counts), as `prepareTransfer`'s own quote request does.
 */
import type { Hex } from 'viem';

import type { StellarSdkPaymentRequest } from '@/services/payment-request-codec';
import { loadStellarSdk } from '@/services/stellar/stellar-runtime';

/** The slice of the session this path touches. */
export interface TransferOnceSession {
  relayTransfer(option: Record<string, unknown>): Promise<{
    txReceipt: { status: boolean; txHash: unknown };
    spentNullifiersConfirmed?: boolean;
  }>;
  /** The SDK's transfer delegate (`PoolSession.delegates.transfer`), reached for its pure local helpers only. */
  delegates: {
    transfer: {
      resolveRecipient(params: { inputCommitments: Hex[]; recipientDiscoveryData: { evmAddress: string } }): Promise<Record<string, unknown>>;
      generateNoteSecretsMap(inputCommitments: readonly Hex[], address: string): Map<string, string>;
      core: {
        resolveAndValidateTransactInputs(commitments: readonly Hex[], total: Hex, tokenId: string): { inputNotes: unknown[] };
        getTransactOutputNotes(
          inputNotes: unknown[],
          amount: Hex,
          feeAmount: Hex,
          tokenId: string,
          recipient: unknown,
        ): { recipientNotes: { commitment: string; noteAddressHash: string; value: string; tokenId: string; label: string }[] };
      };
    };
  };
}

export interface TransferOnceRelayer {
  getRelayers(): Promise<unknown[]>;
  getTransferQuote(relayer: unknown, params: Record<string, unknown>): Promise<{ feeCommitment: { feeAmount: string | bigint } }>;
}

export interface OneTimeRecipientNote {
  commitment: string;
  noteAddressHash: string;
  noteSecret: string;
  value: string;
  tokenId: string;
  label: string;
}

export type TransferOnceAction = {
  inputCommitments: Hex[];
  /**
   * One-time only: called with the notes the relayed transaction will create, BEFORE anything is
   * sent. Throwing here sends nothing.
   */
  beforeRelay?: (notes: OneTimeRecipientNote[]) => void | Promise<void>;
  /** Throws to stop before the relay request. */
  guard?: () => void;
  onRelaying?: () => void;
} & (
  | { amount: bigint; recipient: { kind: 'registered' | 'oneTime'; address: string } }
  | { paymentRequest: StellarSdkPaymentRequest }
);

export type TransferOnceParams = TransferOnceAction & {
  tokenId: string;
  /** The most the relayer may charge; the inputs were selected for amount plus this. */
  maxFee: bigint;
  maxInputs: number;
  maxOutputs: number;
};

const toHex = (value: bigint): Hex => `0x${value.toString(16)}`;

export async function relayTransferOnce(
  session: TransferOnceSession,
  relayer: TransferOnceRelayer,
  params: TransferOnceParams,
) {
  const { inputCommitments } = params;
  let tokenId = params.tokenId;
  let amount: bigint;
  if ('paymentRequest' in params) {
    const sdk = await loadStellarSdk();
    // Match prepareFulfillPaymentRequest's validation before requesting a quote.
    const schema = sdk.makePaymentRequestSchemas(sdk.StellarAddressSchema).fulfillPaymentRequestParamsSchema;
    const validated = schema.safeParse({ paymentRequest: params.paymentRequest, inputCommitments });
    if (!validated.success) throw new sdk.InvalidTransactParams(validated.error.issues[0].message);
    const request = validated.data.paymentRequest;
    if (request.expiresAt !== undefined) {
      const nowMs = BigInt(Date.now());
      if (nowMs > BigInt(request.expiresAt)) throw new sdk.PaymentRequestExpired(request.expiresAt, nowMs);
    }
    amount = BigInt(request.amount);
    tokenId = request.tokenId;
  } else {
    amount = params.amount;
  }
  const [relayerInfo] = await relayer.getRelayers();
  if (!relayerInfo) throw new Error('The relayer did not return a quote.');
  const count = inputCommitments.length;
  const quote = await relayer.getTransferQuote(relayerInfo, {
    asset: tokenId,
    commit: true,
    shape: { n: Math.min(count, params.maxInputs), m: Math.min(2 * count, params.maxOutputs) },
  });
  const fee = BigInt(quote.feeCommitment.feeAmount);
  // As on EVM, the committed fee must fit the selected inputs after the recipient amount.
  if (fee > params.maxFee) throw new Error("The notes picked for this payment can't cover it.");

  const transfer = session.delegates.transfer;
  let recipient: Record<string, unknown>;
  if ('paymentRequest' in params) {
    // Use the validated request's slots and key; no address or secrets lookup.
    const request = params.paymentRequest;
    recipient = { noteAddressHash: request.noteAddressHashes, publicViewingKey: request.paymentPubKey, hint: request.tag };
  } else if (params.recipient.kind === 'registered') {
    // The SDK resolves the viewing key here and throws RecipientViewingKeyUnregistered when there
    // is none, so no separate lookup naming the recipient is made beforehand. The secrets map stays:
    // relayTransfer builds the note data itself, and without it the notes are encoded blind.
    recipient = await transfer.resolveRecipient({
      inputCommitments,
      recipientDiscoveryData: { evmAddress: params.recipient.address },
    });
  } else {
    const secrets = transfer.generateNoteSecretsMap(inputCommitments, params.recipient.address);
    // Without a viewing key nothing on chain carries these notes, so the relayed request gets the
    // hashes only (no secrets map: the SDK would otherwise read a timestamp per note after the send).
    recipient = { noteAddressHash: Array.from(secrets.keys()) };
    // The notes are sized by the SDK's own output builder from the same inputs, amount and fee the
    // relay will use, so the link names exactly the commitments the relayed transaction creates.
    const { inputNotes } = transfer.core.resolveAndValidateTransactInputs(inputCommitments, toHex(amount + fee), tokenId);
    const { recipientNotes } = transfer.core.getTransactOutputNotes(
      inputNotes,
      toHex(amount),
      toHex(fee),
      tokenId,
      { ...recipient, noteSecretsMap: secrets },
    );
    const notes: OneTimeRecipientNote[] = recipientNotes.map((n) => ({
      commitment: String(n.commitment),
      noteAddressHash: n.noteAddressHash,
      noteSecret: String(secrets.get(n.noteAddressHash) ?? ''),
      value: String(n.value),
      tokenId: String(n.tokenId),
      label: String(n.label),
    }));
    if (notes.length === 0 || notes.some((n) => !n.noteSecret)) {
      throw new Error('The transfer could not be prepared for a one-time link.');
    }
    // Saved before anything is sent: the link is the recipient's only way to the money.
    await params.beforeRelay?.(notes);
  }

  params.guard?.();
  params.onRelaying?.();
  const result = await session.relayTransfer({
    inputCommitments,
    amount: toHex(amount),
    tokenId,
    recipient,
    ...('recipient' in params ? { recipientEvmAddress: params.recipient.address } : {}),
    selectedQuote: { relayerInfo, quote },
  });
  if (result.spentNullifiersConfirmed === false) throw new Error('The relayer reported a transaction that is not this transfer.');
  return result;
}
