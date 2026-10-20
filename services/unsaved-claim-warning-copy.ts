/**
 * Copy for the warning a blind deposit shows when THIS browser cannot save the
 * recipient's claim link locally (storage full, blocked, or a private window
 * that accepts and discards).
 *
 * Why a warning and not a refusal (Pat, 2026-09-16): the sender's on-chain
 * backup travels inside this very deposit (services/blind-deposit-backup.ts),
 * so the chain is the durable copy and the local record is the convenience
 * that lets this browser re-copy the link without a scan. The success screen
 * still shows the link, and the row menu can recover it later. So recommend
 * against, plainly, and let the user decide. Nothing is signed while the
 * warning is up.
 *
 * One place for the strings: proposed to Pat on Telegram 2026-09-16 and
 * awaiting his validation. Sentence breaks, no em dashes.
 */
export const UNSAVED_CLAIM_WARNING = {
  title: 'Storage unavailable',
  body: 'This browser could not save the claim link. It stays recoverable on-chain from the transaction menu. Copy it right after sending.',
  cancel: 'Cancel',
  proceed: 'Continue anyway',
} as const;
