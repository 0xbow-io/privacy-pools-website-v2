// Which surface carries a pay flow's status line (DEV-496).
//
// The status box above the flow and the progress rail below it read the same
// statusMessage, so while a payment runs the user saw the same line twice, and
// after it the box ("Payment sent. ...") sat above the terminal "Payment sent"
// card. One place at a time: the rail while it runs, the success card after.

export type PayStatusSurfaceInput = {
  mode: 'request' | 'pay' | 'receive';
  isBusy: boolean;
  pendingAutoAction: string | null;
  txHash: string | null;
};

/** True when the top status box should stay hidden because another surface already shows it. */
export function payStatusBoxHidden({ mode, isBusy, pendingAutoAction, txHash }: PayStatusSurfaceInput): boolean {
  if (mode !== 'pay') return false;
  // Paid: the success card owns the outcome.
  if (txHash) return true;
  // Running (or armed): the rail prints the same message.
  return isBusy || !!pendingAutoAction;
}

// The lead sentence every pay handler opens its success line with. The card
// already says "Payment sent", so only the rest of the line is worth showing.
const SUCCESS_LEAD = /^(?:Payment sent|Private transfer(?: payment)? sent via relay)\.\s*/;

/**
 * The success card's body: what the handler said after "Payment sent", or the
 * card's own default when the status line is not a success line (for example
 * "Waiting for the transaction to confirm..." while the bulk check runs).
 */
export function paySuccessDetail(statusMessage: string | null, fallback: string): string {
  if (!statusMessage || !SUCCESS_LEAD.test(statusMessage)) return fallback;
  const rest = statusMessage.replace(SUCCESS_LEAD, '').trim();
  return rest || fallback;
}
