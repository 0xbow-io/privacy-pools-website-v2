import { decideRegistrationPath } from '@/services/cold-start-claim';
import type { ReceiveSetupState } from '@/services/receive-setup';

/**
 * Whether a claim starts with the wallet's one-time setup, and how many wallet
 * transactions that is.
 *
 * A user read "A relayer submits this for you", pressed Claim, got two wallet
 * prompts for on-chain transactions and took them for the claim. They were the
 * one-time registration (auth policy, then viewing key) that a wallet pays for
 * itself before the relayed claim. The page has to say so before and while
 * those prompts show.
 *
 * Only the relayer-carried claim sends no wallet transaction. 'none' is
 * therefore said only when the setup is known done, or the relayer is known to
 * pay; anything unknown is 'maybe' (the hedged copy), never 'none'.
 */
export type ClaimSetupPlan =
  | { kind: 'none' }
  | { kind: 'setup'; confirmations: 1 | 2 }
  | { kind: 'maybe' };

/**
 * Who pays, as far as the page knows it.
 *
 * `probed`: the claim's own decision (use-note-import's `claimFunding`, the
 * same `resolveClaimFunding` the claim runs). `estimate`: before that exists,
 * the inputs the claim's decision uses (decideRegistrationPath), read from data
 * the page already holds; `undefined`/`null` means not loaded or failed.
 */
export type ClaimFundingView =
  | { source: 'probed'; kind: 'self-funded' | 'relayed' | 'unfunded' }
  | { source: 'estimate'; balanceWei: bigint | undefined; gasPriceWei: bigint | null | undefined; relayCanRegister: boolean };

function walletPaysPlan(setupState: ReceiveSetupState): ClaimSetupPlan {
  if (setupState === 'complete') return { kind: 'none' };
  if (setupState === 'unregistered') return { kind: 'setup', confirmations: 2 };
  if (setupState === 'partial') return { kind: 'setup', confirmations: 1 };
  return { kind: 'maybe' };
}

export function claimSetupPlan(args: { setupState: ReceiveSetupState; funding: ClaimFundingView }): ClaimSetupPlan {
  const { setupState, funding } = args;
  if (setupState === 'complete') return { kind: 'none' };
  if (funding.source === 'probed') {
    // Relayed: the relayer registers (a free signature) or the account is
    // already registered. Unfunded is still attempted with wallet transactions.
    return funding.kind === 'relayed' ? { kind: 'none' } : walletPaysPlan(setupState);
  }
  // The claim's own rule (decideRegistrationPath): its 'unknown-gas-price'
  // branch keeps the wallet paying, so an unread gas price is never 'none'.
  // Only a known zero or short balance, on a chain whose relay can register
  // the wallet, hands the claim to the relayer.
  const { balanceWei, gasPriceWei, relayCanRegister } = funding;
  if (balanceWei === undefined) return { kind: 'maybe' };
  if (!relayCanRegister) return walletPaysPlan(setupState);
  const decision = decideRegistrationPath({ supported: true, balanceWei, gasPriceWei: gasPriceWei ?? undefined });
  return decision.path === 'relayed-claim' ? { kind: 'none' } : walletPaysPlan(setupState);
}

function confirmationsText(n: number): string {
  return n === 1 ? '1 wallet confirmation' : `up to ${n} wallet confirmations`;
}

/** The two steps, shown before Claim is pressed. Null when there is no setup. */
export function claimSetupSteps(plan: ClaimSetupPlan): { setup: string; claim: string } | null {
  if (plan.kind === 'none') return null;
  const setup = plan.kind === 'setup'
    ? `1. One-time setup: ${confirmationsText(plan.confirmations)}, network fees apply.`
    : '1. If your wallet needs setup: up to 2 wallet confirmations, network fees apply.';
  return { setup, claim: '2. Claim: sent by a relayer, no wallet transaction.' };
}

/**
 * What the claim shows while it runs. The setup's status line comes BEFORE the
 * staged progress, never inside it: the setup prompts ("confirm in your
 * wallet") read as the progress bar's Confirm step, and its phase never steps
 * back, so the bar sat on Confirm while proving had not started (review,
 * 0xmatthewb). Switching surfaces also remounts the progress, so the claim's
 * own steps start again from Prepare once the setup is done.
 */
export function claimProgressSurface(args: { anchoring: boolean; claimPhase: 'setup' | 'claim' }): 'setup-line' | 'progress' | 'none' {
  if (!args.anchoring) return 'none';
  return args.claimPhase === 'setup' ? 'setup-line' : 'progress';
}

/** The status line while a setup transaction is out. */
export function claimSetupLegMessage(leg: number, total: number, stage: 'confirm' | 'confirming'): string {
  const which = total > 1 ? ` ${leg} of ${total}` : '';
  return stage === 'confirm'
    ? `One-time setup${which}: confirm in your wallet. This is not the claim yet.`
    : `One-time setup${which}: waiting for the network.`;
}
