import { FEE_COMMITMENT_EXPIRED_MESSAGE } from '../../services/fee-commitment';

/** Only the app's explicit pre-broadcast expiry verdict permits resubmission. */
export function canRetryExpiredWithdrawal(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ');
  return normalized.includes(FEE_COMMITMENT_EXPIRED_MESSAGE)
    && !/outcome unknown|Withdrawal Successful|transaction reverted/i.test(normalized);
}
