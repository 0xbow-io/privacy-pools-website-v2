/**
 * Recover blind-deposit claim material from the sender's own on-chain backups.
 *
 * The emit side is services/blind-deposit-backup.ts. This is the read side:
 * take the pool's Note events this client already holds, try each one against
 * the sender's viewing key, keep the ones that decode as OUR backup payload.
 * Any browser the sender signs into can do this, which is the whole point -
 * the claim link no longer lives in one browser's localStorage.
 *
 * NO PERSISTENCE, ON PURPOSE. Writing recovered secrets back into localStorage
 * would recreate the exposure this exists to reduce (Pat, 2026-09-16). The
 * chain is the durable store; this reads it when a link is actually needed.
 *
 * PRIVACY. Nothing here sends a request. The Note events come from the event
 * snapshot the feed grid holds (services/snapshot-source.ts), whose Note
 * section is recorded into services/note-ciphertexts.ts along with anything
 * newer discovery has read. Recovery runs when the user presses "Recover claim
 * link", so a fetch here would tell the ASP the moment this client went looking
 * for a deposit it made, even though the request names nothing. The optional
 * `txHash` narrowing happens client-side over what is held.
 *
 * THIN BY DESIGN. Every decision lives in the pure module and its tests; this
 * file only reaches the SDK runtime, which pulls in React Native and so cannot
 * be exercised under bun. Keep it that way.
 */
import { createCryptoService } from '@/services/sdk-setup';
import { decryptBlindDepositBackup, type BackupCryptoLike, type HexString } from '@/services/blind-deposit-backup';
import { allNoteCiphertexts, noteCiphertextsFor } from '@/services/note-ciphertexts';
import { loadPoolEventSnapshot } from '@/services/snapshot-source';

export type RecoveredBlindClaim = {
  chainId: number;
  /** The deposit tx: what the transaction row is keyed on. */
  txHash: HexString;
  noteSecret: HexString;
  value: HexString;
  tokenId: HexString;
  label: HexString;
};

/**
 * Scan for the sender's backups.
 *
 * `viewingPrivateKey` is the signed-in account's own key
 * (`keystoreManager.getViewingKeyPair().privateKey`). It never leaves this
 * function, and nothing is asked of anyone.
 */
export async function recoverBlindDepositClaims(input: {
  chainId: number;
  viewingPrivateKey: string;
  /** Narrow to one deposit, client-side. Omit to recover every backup. */
  txHash?: string | null;
}): Promise<RecoveredBlindClaim[]> {
  // Reading the held snapshot records its Note section; a read never fetches.
  let loadError: unknown = null;
  try {
    await loadPoolEventSnapshot(input.chainId);
  } catch (err) {
    loadError = err;
  }
  const wanted = input.txHash ? input.txHash.toLowerCase() : null;
  const events = wanted
    ? noteCiphertextsFor(input.chainId, wanted).map((c) => ({ ...c, txHash: wanted }))
    : allNoteCiphertexts(input.chainId);
  // Nothing held and the snapshot unreadable: say so rather than "no backup".
  if (events.length === 0 && loadError) throw loadError;

  const crypto = createCryptoService() as unknown as BackupCryptoLike;
  const out: RecoveredBlindClaim[] = [];
  for (const event of events) {
    const payload = decryptBlindDepositBackup({
      ephemeralPubKey: event.ephemeralPubKey,
      encryptedPayload: event.encryptedPayload,
      viewingPrivateKey: input.viewingPrivateKey,
      crypto,
    });
    if (!payload) continue;
    out.push({
      chainId: input.chainId,
      txHash: event.txHash.toLowerCase() as HexString,
      ...payload,
    });
  }
  return out;
}
