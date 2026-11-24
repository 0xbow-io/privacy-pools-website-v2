import type { ReceiveSetupState } from '@/services/receive-setup';

/**
 * Whether a claim starts with the wallet's one-time setup, and how many wallet
 * transactions that is.
 *
 * A user read "A relayer submits this for you", pressed Claim, got two wallet
 * prompts for on-chain transactions and took them for the claim. They were the
 * one-time registration (auth policy, then viewing key) that a wallet holding
 * gas pays for itself before the relayed claim. The page has to say so before
 * and while those prompts show.
 *
 * Only a wallet that pays its own setup sends transactions: an unfunded one is
 * registered by the relayer (a free signature, no transaction). 'maybe' is a
 * funded wallet whose setup state this session has not read yet.
 */
export type ClaimSetupPlan =
  | { kind: 'none' }
  | { kind: 'setup'; confirmations: 1 | 2 }
  | { kind: 'maybe' };

export function claimSetupPlan(args: { setupState: ReceiveSetupState; walletPaysGas: boolean }): ClaimSetupPlan {
  const { setupState, walletPaysGas } = args;
  if (!walletPaysGas) return { kind: 'none' };
  if (setupState === 'unregistered') return { kind: 'setup', confirmations: 2 };
  if (setupState === 'partial') return { kind: 'setup', confirmations: 1 };
  if (setupState === 'unknown') return { kind: 'maybe' };
  return { kind: 'none' };
}

function confirmationsText(n: number): string {
  return n === 1 ? '1 wallet confirmation' : `${n} wallet confirmations`;
}

/** The two steps, shown before Claim is pressed. Null when there is no setup. */
export function claimSetupSteps(plan: ClaimSetupPlan): { setup: string; claim: string } | null {
  if (plan.kind === 'none') return null;
  const setup = plan.kind === 'setup'
    ? `1. One-time setup: ${confirmationsText(plan.confirmations)}, you pay gas once.`
    : '1. One-time setup, first claim with this wallet only: up to 2 wallet confirmations, you pay gas once.';
  return { setup, claim: '2. Claim: sent by a relayer, no wallet transaction.' };
}

/** The status line while a setup transaction is out. */
export function claimSetupLegMessage(leg: number, total: number, stage: 'confirm' | 'confirming'): string {
  const which = total > 1 ? ` ${leg} of ${total}` : '';
  return stage === 'confirm'
    ? `One-time setup${which}: confirm in your wallet. This is not the claim yet.`
    : `One-time setup${which}: waiting for the network.`;
}
