/**
 * Relayed Stellar transfers with one proof.
 *
 * The SDK's `prepareTransfer` / `prepareColdStartTransfer` prove a self-submit transact only to hand
 * back `relayOptions`, and `relayTransfer` then proves again with the relayer's fee: the first
 * proof (about 10 s in the browser) is thrown away. Like `withdraw()`, the account builds the relay
 * option itself from the relayer's committed quote and calls `relayTransfer` once.
 *
 * Everything here uses the SDK's public exports only. The one rule restated from the SDK is how a
 * transfer's recipient notes are cut (`TransactOrchestrator.getTransactOutputNotes`, private), which
 * a one-time link needs before anything is sent. That restatement is never trusted on its own: the
 * link's commitments are checked against the proof's public outputs after the single proof and
 * before the relay request, and a mismatch refuses the send (`assertProofCreates`).
 *
 * Pure module (no react-native, no SDK import) so it is bun-testable.
 */
import type { Hex, IRelayerInteractor, StellarAddress, TransferRelayParams } from '@privacy-pools-v2/stellar-sdk';

/** The SDK's transact limits (MAX_INPUTS / MAX_OUTPUTS). */
const MAX_INPUTS = 5;
const MAX_OUTPUTS = 5;

/**
 * The proof shape a transfer quote is priced by, exactly as the SDK asks for it
 * (`PoolSessionTransfer.getTransferRelayerQuotes`): `n` inputs, at most a change and a recipient
 * note per input label. Same body as before, so the relayer sees no new request.
 */
export function transferQuoteShape(inputCount: number): { n: number; m: number } {
  return { n: Math.min(inputCount, MAX_INPUTS), m: Math.min(2 * inputCount, MAX_OUTPUTS) };
}

type NoteComputation = {
  computeNoteAddressHash(ownerField: Hex, noteSecret: Hex): Hex | string;
  computeFullCommitment(params: { noteAddressHash: Hex; tokenId: Hex; value: Hex; label: Hex }): Hex | string;
};

export type RecipientSecrets = { noteAddressHash: Hex[]; noteSecretsMap: Map<Hex, Hex> };

/**
 * One fresh secret per input commitment, keyed by Poseidon(recipient, secret): what the SDK's
 * `generateNoteSecretsMap` builds for both `prepareTransfer` (registered recipient) and
 * `prepareColdStartTransfer` (one-time link). Labels take the hashes positionally.
 */
export function newRecipientSecrets(
  deps: { computation: NoteComputation; generateSecret: () => Hex | string; recipientField: Hex },
  inputCount: number,
): RecipientSecrets {
  const noteSecretsMap = new Map<Hex, Hex>();
  while (noteSecretsMap.size < inputCount) {
    const secret = String(deps.generateSecret()) as Hex;
    // Keyed by the hash service's own output, exactly as the SDK keys it.
    noteSecretsMap.set(String(deps.computation.computeNoteAddressHash(deps.recipientField, secret)) as Hex, secret);
  }
  return { noteAddressHash: [...noteSecretsMap.keys()], noteSecretsMap };
}

/**
 * The recipient notes a transfer of `amount` from `inputNotes` creates (input order, as given to
 * the SDK): labels in first-occurrence order, each paying min(label total, what is left of
 * `amount`), the i-th label taking the i-th hash. The relayer's fee only shrinks the change, so
 * this does not depend on the quote.
 */
export function predictRecipientNotes(
  inputNotes: readonly { label: string; value: string | bigint }[],
  amount: bigint,
  noteAddressHash: readonly Hex[],
): { label: Hex; value: bigint; noteAddressHash: Hex }[] {
  const totals = new Map<string, bigint>();
  for (const n of inputNotes) totals.set(String(n.label), (totals.get(String(n.label)) ?? 0n) + BigInt(n.value));
  if (noteAddressHash.length < totals.size) throw new Error('The transfer could not be prepared for a one-time link.');
  const out: { label: Hex; value: bigint; noteAddressHash: Hex }[] = [];
  let left = amount;
  let i = 0;
  for (const [label, total] of totals) {
    if (left > 0n) {
      const value = left >= total ? total : left;
      out.push({ label: label as Hex, value, noteAddressHash: noteAddressHash[i] });
      left -= value;
    }
    i++;
  }
  if (left > 0n) throw new Error('The selected notes do not cover this amount.');
  return out;
}

/** Commitment = Poseidon(Poseidon(noteAddressHash, token, value, standard), label), as the SDK computes it. */
export function recipientCommitment(
  computation: NoteComputation,
  tokenField: Hex,
  note: { label: Hex; value: bigint; noteAddressHash: Hex },
): Hex {
  return hex32(computation.computeFullCommitment({
    noteAddressHash: note.noteAddressHash,
    tokenId: tokenField,
    value: `0x${note.value.toString(16)}` as Hex,
    label: note.label,
  }));
}

/**
 * Refuses a proved transfer that does not create exactly these recipient commitments. The proof's
 * public signals lead with the `n` input nullifiers, then the `m` output commitments; the relayer
 * submits those, so this is what the chain will hold.
 */
export function assertProofCreates(
  params: Pick<TransferRelayParams<StellarAddress>, 'proof' | 'inputNullifierNumber' | 'outputCommitmentNumber'>,
  commitments: readonly Hex[],
  labelCount: number,
): void {
  const n = params.inputNullifierNumber;
  const m = params.outputCommitmentNumber;
  const outputs = new Set(params.proof.publicSignals.slice(n, n + m).map((s) => BigInt(s)));
  const ok = m === labelCount + commitments.length && commitments.every((c) => outputs.has(BigInt(c)));
  if (!ok) throw new Error('The transfer could not be prepared for a one-time link. Nothing was sent.');
}

/**
 * The relayer with `beforeSend` run after the transfer is proved and before it is posted. A throw
 * there stops the send; nothing has left the browser for this transfer yet.
 */
export function relayerWithBeforeSend(
  relayer: IRelayerInteractor<StellarAddress>,
  beforeSend: (params: TransferRelayParams<StellarAddress>) => void | Promise<void>,
): IRelayerInteractor<StellarAddress> {
  return new Proxy(relayer, {
    get(target, prop, receiver) {
      if (prop === 'relayTransfer') {
        return async (info: Parameters<IRelayerInteractor<StellarAddress>['relayTransfer']>[0], params: TransferRelayParams<StellarAddress>) => {
          await beforeSend(params);
          return target.relayTransfer(info, params);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function hex32(v: Hex | string): Hex {
  return `0x${BigInt(v).toString(16).padStart(64, '0')}` as Hex;
}
