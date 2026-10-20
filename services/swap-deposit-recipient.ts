// Who a pay-with or cross-chain Shield deposit is for (DEV-489).
//
// The SDK's swap-and-deposit takes a `recipient` in the same forms as
// prepareDepositFor (v2-monorepo#467) and embeds THAT deposit proof in the
// swap's deposit call, so the note is the recipient's:
//
// - registered recipient: `{ discoveryData: { evmAddress } }`, announced to
//   their viewing key, which they discover on their next sync;
// - unregistered recipient: the blind form, with the same sender-recoverable
//   backup as a plain blind deposit (services/blind-deposit-backup.ts) as the
//   announcement, and a claim link afterwards.
//
// The blind backup has to name the note the proof commits to, and on this path
// the app does not know that note up front: a yield pool commits SHARES the SDK
// sizes from the budget, and a bridge refit or a smaller retry target moves the
// value again. So the backup is a builder the SDK calls once the note is fixed,
// and each built note is reported back keyed by commitment, so the claim record
// can be written for exactly the route that gets signed.
//
// Pure: services are injected, nothing here touches the network.

import {
  buildBlindDepositBackup,
  type BackupCryptoLike,
  type BackupNoteComputationLike,
} from '@/services/blind-deposit-backup';
import type { SwapDepositNoteLike, SwapDepositRecipient } from '@/services/swap-flows';

type Hex = `0x${string}`;

/** The material a blind deposit already minted for its claim link. */
export interface BlindSwapRecipientInput {
  noteSecret: Hex;
  depositSecret: Hex;
  senderViewingPubKey: string;
  noteAddressHash: Hex;
  noteComputation: BackupNoteComputationLike;
  crypto: BackupCryptoLike;
  randomFill: (out: Uint8Array) => void;
}

/** What a claim record needs about the committed note, beyond the SDK's pendingNote. */
export interface BuiltClaimNote {
  tokenId: Hex;
  value: Hex;
  /** The label and commitment the proof commits to, as the SDK built them. */
  label: Hex;
  commitment: Hex;
}

/** One key per commitment, whatever its hex spelling (padding, case). */
export function commitmentKey(commitment: string): string {
  return BigInt(commitment).toString(16);
}

export class SwapRecipientBackupMismatch extends Error {
  constructor() {
    super('the claim backup does not match the prepared deposit');
    this.name = 'SwapRecipientBackupMismatch';
  }
}

/**
 * The SDK recipient for a deposit to `recipient`. `blind` set means the
 * recipient has no viewing key: the blind form, whose builder reports every
 * note it builds through `onNote`.
 */
export function swapDepositRecipient(args: {
  recipient: Hex;
  blind: BlindSwapRecipientInput | null;
  onNote?: (key: string, note: BuiltClaimNote) => void;
}): SwapDepositRecipient {
  const { recipient, blind } = args;
  if (!blind) return { discoveryData: { evmAddress: recipient } };
  return {
    noteAddressHash: blind.noteAddressHash,
    depositSecret: blind.depositSecret,
    noteData: (note: SwapDepositNoteLike) => {
      const tokenId = note.tokenId.toLowerCase() as Hex;
      const backup = buildBlindDepositBackup({
        recipient,
        tokenId,
        value: note.value,
        noteSecret: blind.noteSecret,
        depositSecret: blind.depositSecret,
        senderViewingPubKey: blind.senderViewingPubKey,
        noteComputation: blind.noteComputation,
        crypto: blind.crypto,
        randomFill: blind.randomFill,
      });
      // A backup that names a different note than the proof commits to would
      // recover a link that can never be claimed. The SDK turns this throw
      // into a refusal before anything is proved or signed.
      if (BigInt(backup.label) !== BigInt(note.label) || BigInt(backup.commitment) !== BigInt(note.commitment)) {
        throw new SwapRecipientBackupMismatch();
      }
      args.onNote?.(commitmentKey(note.commitment), { tokenId, value: note.value, label: note.label, commitment: note.commitment });
      return backup.noteData;
    },
  };
}
