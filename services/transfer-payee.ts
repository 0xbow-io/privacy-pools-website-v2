import { findSentTransfer } from '@/services/sent-transfers-store';
import { findPaidRequest } from '@/services/paid-requests-store';
import { findSentAudit } from '@/services/audit-store';

/**
 * Who a transfer this device sent paid, from whichever local record names
 * them: the Send flow's stamp, a paid payment request, or the recipient
 * note's disclosure. The chain never names the payee, not even to the
 * sender: the recipient note's secret and the key its Note is encrypted
 * with are both random and kept only on the sending device. A transfer
 * sent from another device has none of these, so this returns null there.
 */
export function recordedTransferPayee(txHash: string | null | undefined): string | null {
  if (!txHash) return null;
  return findSentTransfer(txHash)?.recipient
    ?? findPaidRequest(txHash)?.recipient
    ?? findSentAudit(txHash)?.ownerAddress
    ?? null;
}
