// The line under "Deposit to" while an address is being entered.
//
// Depositing to an address that has not registered works (a blind deposit
// plus a one-time claim link, deposit-modal-provider.tsx), but it is a very
// different experience from depositing to a registered one, and until now the
// form said nothing until Shield was pressed. This is the copy for the
// registration states the hub now checks while typing (Mike, 2026-09-22), and
// the docs page the "Learn more" link opens. Pure, so the copy is tested.

export type RecipientRegistrationState = 'idle' | 'checking' | 'registered' | 'unregistered' | 'unknown';

/** The user-facing docs page that explains the claim-link flow end to end. */
export const UNREGISTERED_DEPOSIT_DOCS_URL = 'https://privacy-pools-v2-docs.vercel.app/using/deposit-to-unregistered';

export const LEARN_MORE_UNREGISTERED_LABEL = 'Learn more about deposits to unregistered addresses';

/**
 * The hint for a registration state, or null when the form should say
 * nothing while the recipient field is empty. A registered address still
 * needs the ownership disclosure: the payer's unlock cannot access its notes.
 *
 * Registration is per network, so the unregistered line names the one that was
 * checked: an address set up on BNB Chain and not on Ethereum read as "hasn't
 * set up Privacy Pools" on Ethereum, which looked wrong to its owner (Mike,
 * 2026-09-24).
 */
export function recipientRegistrationHint(
  state: RecipientRegistrationState,
  chainName?: string,
): { text: string; learnMore: boolean; tone: 'muted' | 'warning' } | null {
  switch (state) {
    case 'registered':
      return { text: 'The recipient must sign in to their account to access these funds.', learnMore: false, tone: 'muted' };
    case 'checking':
      return { text: 'Checking whether this address is registered…', learnMore: false, tone: 'muted' };
    case 'unregistered':
      return {
        text: `This address hasn’t set up Privacy Pools${chainName ? ` on ${chainName}` : ''} yet. You’ll get a one-time claim link to send them.`,
        learnMore: true,
        tone: 'warning',
      };
    case 'unknown':
      return { text: 'Couldn’t check this address right now. Try again in a moment.', learnMore: false, tone: 'muted' };
    default:
      return null;
  }
}

/**
 * DEV-511 (Mike): for a private swap-send, "has an account" means a viewing key
 * published on the chain where the note is CREATED, the destination of a
 * cross-chain send. Registered only on Ethereum and sending to BNB Chain still
 * needs a claim link, so the notice names that chain.
 */
export function swapSendUnregisteredNotice(destinationChainName?: string): string {
  return `This address doesn’t have a Privacy Pools account${destinationChainName ? ` on ${destinationChainName}` : ''}. You’ll get a claim link to send them.`;
}

/** The address is complete and well-formed, so a registration lookup is worth running. */
export function isCheckableRecipient(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(v) && v !== '0x0000000000000000000000000000000000000000';
}

/** Signed in with an account key, the deposit is owned by that key. */
export const KEY_SESSION_DEPOSIT_FOR_COPY = 'Depositing to another address needs a wallet sign-in. Sign in with your wallet, or clear the address.';

/**
 * Why the Shield card cannot deposit to another address with the current
 * choices, or null when it can, said up front instead of after Shield is
 * pressed (Mike, 2026-09-24).
 *
 * DEV-489: paying with another token or from another network now works too.
 * The SDK's swap-and-deposit takes a recipient (v2-monorepo#467) and embeds
 * THEIR depositFor proof, for a plain pool and a yield pool alike. So the only
 * refusal left is the account-key session, whose deposits belong to the key.
 */
export function recipientDepositConflict(c: {
  /** Signed in with an account key: the deposit is owned by that key, never by someone else. */
  keySession?: boolean;
}): string | null {
  if (c.keySession) return KEY_SESSION_DEPOSIT_FOR_COPY;
  return null;
}
