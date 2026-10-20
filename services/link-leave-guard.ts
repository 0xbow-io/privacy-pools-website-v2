// Leaving a screen whose link is the recipient's only way to the money.
//
// Two surfaces hand the sender a one-time link: a deposit to an unregistered
// address (the claim link, DEV-491) and a send to one (the receipt, DEV-487).
// Both used to let the sender walk away without it: the deposit's copy button
// was easy to miss, and the send's Done silently kept the receipt screen up.
// One rule for both: leaving before the link was copied asks first.

export type LinkLeaveCopy = { title: string; body: string; copyLabel?: string; copyFailed?: string };

/** True when leaving now would drop a link the sender has not copied. */
export function needsLeaveConfirm(state: { link: string | null | undefined; copied: boolean }): boolean {
  return !!state.link && !state.copied;
}

/** Deposit to an unregistered address (DEV-491). */
export const CLAIM_LINK_LEAVE: LinkLeaveCopy = {
  title: 'Did you copy the claim link?',
  body: "Without it the recipient can't claim. You can recover it later from My transactions (row menu → Recover claim link).",
};

/** The one-line instruction beside the claim link on the success card. */
export const CLAIM_LINK_INSTRUCTION = 'Send this link to the recipient. They need it to claim the funds.';

/**
 * Send with a one-time receipt (DEV-487). `recoverable` is whether the receipt
 * was stored on this device, which is what the history row's "Copy payment
 * link" rebuilds from. Without it the screen is the only copy, and the
 * warning has to say so rather than promise a recovery that cannot happen.
 */
export function receiptLeaveCopy(recoverable: boolean): LinkLeaveCopy {
  return recoverable
    ? {
      title: 'Leave without copying the receipt?',
      body: 'If this transfer went through, the recipient can only claim it with this link. You can copy it again later from My transactions (row menu → Copy payment link).',
    }
    : {
      title: 'Leave without copying the receipt?',
      body: 'This receipt was not saved on this device. If this transfer went through, the recipient can only claim it with this link, and it cannot be recovered later.',
    };
}

/** A Sui send's receipt is JSON, not a link, and is never stored for recovery. */
export const SUI_RECEIPT_LEAVE: LinkLeaveCopy = {
  title: 'Leave without copying the receipt?',
  body: 'If this transfer went through, the recipient can only claim it with this JSON receipt (Actions → Payments → Import Note), and it cannot be recovered later.',
  copyLabel: 'Copy JSON and close',
  copyFailed: 'Could not copy. Use Copy JSON on the screen, then close.',
};
