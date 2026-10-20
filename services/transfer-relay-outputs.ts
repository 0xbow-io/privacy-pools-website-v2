// The point between a relayed transfer's one proof and its POST.
//
// relayTransfer proves inside the SDK and hands the request straight to the
// relayer interactor, so the request is the first place the app sees the
// proof's output commitments. Everything a flow stores before the relay (the
// out-of-band receipt, the audit disclosures, the outputs a mined spend is
// matched against) comes from its own plan of those outputs. This check holds
// the proof to that plan and refuses the request when they differ, before
// anything leaves, so a stored receipt can never name a note the transaction
// did not create.
//
// Every relayed transfer is planned, so a transfer request with no plan armed
// is refused too.

import type { Hash } from '@/services/sdk-types';

/** Shown when a proof's outputs differ from the plan; nothing was sent. */
export const TRANSFER_PLAN_MISMATCH_MESSAGE =
  'The prepared transfer does not match what was reviewed. Nothing was sent and your balance is unchanged. Please try again.';

export type TransferRelayExpectation = {
  /** The signed fee commitment this relay carries; it names the request. */
  signedRelayerCommitment: string;
  inputCount: number;
  /** One owned change output per input label, first in the proof. */
  changeCount: number;
  /** The planned recipient commitments, in the proof's order after the change. */
  recipientCommitments: readonly Hash[];
};

export type TransferRelayCheck = {
  /** Every output commitment the checked proof carries, change first; null until checked. */
  outputs: () => Hash[] | null;
  release: () => void;
};

type Armed = TransferRelayExpectation & { outputs: Hash[] | null };

const armed = new Set<Armed>();

/** Arm the check for one relay. Release it once the relay settles. */
export function expectTransferRelay(expectation: TransferRelayExpectation): TransferRelayCheck {
  const entry: Armed = { ...expectation, outputs: null };
  armed.add(entry);
  return {
    outputs: () => entry.outputs,
    release: () => { armed.delete(entry); },
  };
}

type TransferRelayBody = {
  signedFeeCommitment?: { signedRelayerCommitment?: unknown };
  proof?: { publicSignals?: unknown };
  inputNullifierNumber?: unknown;
  outputCommitmentNumber?: unknown;
};

function asField(value: unknown): bigint | null {
  if (typeof value !== 'string' && typeof value !== 'bigint' && typeof value !== 'number') return null;
  try { return BigInt(value); } catch { return null; }
}

function refuse(): never {
  throw new Error(TRANSFER_PLAN_MISMATCH_MESSAGE);
}

/**
 * Runs on every relay request (services/sdk-setup.ts). A transfer request must
 * match an armed plan: the same signed commitment, input count and output
 * count, and recipient commitments equal to the planned ones in order.
 */
export function checkTransferRelay(method: string, params: unknown): void {
  if (method !== 'relayTransfer') return;
  const body = (params ?? {}) as TransferRelayBody;
  const signed = body.signedFeeCommitment?.signedRelayerCommitment;
  const signals = body.proof?.publicSignals;
  const n = body.inputNullifierNumber;
  const m = body.outputCommitmentNumber;
  if (typeof signed !== 'string' || !Array.isArray(signals) || typeof n !== 'number' || typeof m !== 'number') refuse();
  const outputs = signals.slice(n, n + m).map(asField);
  if (outputs.length !== m || outputs.some((f) => f === null)) refuse();
  // A signature need not be unique to one request, so every plan carrying it
  // is tried; the proof's outputs decide which one it is. A plan already
  // matched belongs to an earlier request.
  for (const entry of armed) {
    if (entry.outputs) continue;
    if (entry.signedRelayerCommitment.toLowerCase() !== signed.toLowerCase()) continue;
    if (n !== entry.inputCount || m !== entry.changeCount + entry.recipientCommitments.length) continue;
    if (outputs.slice(entry.changeCount).some((f, i) => f !== BigInt(entry.recipientCommitments[i]))) continue;
    entry.outputs = outputs.map((f) => `0x${(f as bigint).toString(16).padStart(64, '0')}` as Hash);
    return;
  }
  refuse();
}
