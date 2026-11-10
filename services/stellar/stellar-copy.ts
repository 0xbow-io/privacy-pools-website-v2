/**
 * User-facing wording for the Stellar flows: the loading line for each stage
 * of services/stellar/stellar-account.ts, and a translation of the SDK's and
 * Soroban's error text into something a person can act on.
 *
 * Pure module (no react-native) so it is bun-testable.
 */
import type { StellarFlowStage } from '@/services/stellar/stellar-account';

export function describeStellarStage(stage: StellarFlowStage): string {
  switch (stage) {
    case 'unlocking':
      return 'Unlocking your private account (sign in Freighter)...';
    case 'registering':
      return 'Setting up your private account (up to two approvals in Freighter)...';
    case 'proving':
      return 'Building the zero-knowledge proof...';
    case 'signing':
      return 'Submitting (approve in Freighter)...';
    case 'confirming':
      return 'Waiting for confirmation...';
    case 'registering-label':
      return 'Submitting for approval (approve in Freighter)...';
    case 'relaying':
      return 'Sending through the relayer...';
    case 'syncing':
      return 'Updating your balance...';
  }
}

const RULES: [RegExp, string][] = [
  // The network's own refusals of a send (Transaction send failed: <code>): THIS transaction did not
  // reach the chain. An earlier step of the same flow may have (the first of the two account setup
  // transactions), and a retry builds only the missing step, so the copy is scoped to this one.
  [/\btxTooLate\b/, 'The approval took too long and the network refused it. This transaction was not sent. Try again.'],
  [/\btxBadSeq\b/, 'Another transaction from this wallet went through first. This transaction was not sent. Try again.'],
  [/network.*mismatch|StellarWalletNetworkMismatch/i, 'Freighter is on another network. Switch it to Testnet and try again.'],
  [/not installed|StellarWalletNotAvailable/i, 'Freighter is not available in this browser.'],
  [/locked|not connected/i, 'Unlock Freighter and try again.'],
  // Before the generic 'not active' / 'insufficient' rules: these are note
  // state, not wallet state.
  [/RecipientViewingKeyUnregistered|no on-chain viewing key/i, 'The recipient has not set up a private account on Stellar yet. They need to open the app and make any private action first.'],
  [/TransactNoteNotActive|is not ACTIVE/i, 'Some of these funds are not available right now (still awaiting approval, or already spent). Sync and try again.'],
  [/InsufficientTransactValue|Insufficient value for transact/i, 'Your available private notes do not cover this amount. Sync and try a smaller amount.'],
  [/ASP is not configured/i, 'Stellar is not set up on this site yet.'],
  [/testnet indexer unreachable/i, 'The Stellar testnet indexer is not reachable. Try again later.'],
  [/ASPUnavailable|testnet ASP unreachable/i, 'The Stellar testnet ASP is not reachable. Try again later.'],
  [/insufficient|underfunded|balance/i, 'Not enough XLM in the wallet to cover this and the network fee.'],
  [/viewing key|not registered|KeystoreRecipient/i, 'The recipient has not set up a private account on Stellar yet.'],
];

/**
 * A Soroban simulation that a contract rejected. The raw text carries the whole
 * diagnostic event log, whose words would trip the rules below (a log that says
 * "balance" is not a wallet short of XLM), so it is handled first.
 */
const CONTRACT_ERROR = /Error\(Contract, #(\d+)\)/;

export function stellarErrorMessage(raw: string): string {
  const contract = CONTRACT_ERROR.exec(raw);
  if (contract) {
    return `The network rejected this transaction (error #${contract[1]}). Nothing was sent. Sync and try again.`;
  }
  for (const [pattern, message] of RULES) {
    if (pattern.test(raw)) return message;
  }
  // Soroban errors can carry a whole XDR blob; keep the head only.
  return raw.length > 240 ? `${raw.slice(0, 240)}…` : raw;
}

/** Toast title for a failed Stellar sign-in or manual sync (cancelled vs real failure). */
export function stellarUnlockErrorTitle(caught: unknown): string {
  const raw = caught instanceof Error ? caught.message : String(caught);
  // A contract rejection's diagnostic log can contain these words too.
  const cancelled = /reject|denied|cancel|declined/i.test(raw) && !CONTRACT_ERROR.test(raw);
  return cancelled ? 'Sign-in cancelled in Freighter.' : stellarErrorMessage(raw);
}
