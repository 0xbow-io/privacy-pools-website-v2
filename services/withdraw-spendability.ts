// Identity helpers for the withdraw association-set result.
//
// The association-set lookup is asynchronous, while its inputs (chain,
// session, and local notes) can change synchronously. Keeping the result keyed
// prevents a resolved set for the previous inputs from masquerading as the
// answer for the current render.

export type WithdrawSpendabilityNote = {
  commitment: unknown;
  label: unknown;
  status: unknown;
  /** Sui's cached ASP verdict; omitted by EVM notes. */
  aspApproved?: boolean;
};

export type WithdrawSpendabilityResolution = {
  key: string;
  commitments: Set<string>;
};

function isActiveStatus(status: unknown): boolean {
  const value = String(status);
  return value === 'ACTIVE' || value === 'active';
}

/** Stable identity for the inputs that determine EVM note spendability. */
export function buildWithdrawSpendabilityKey(params: {
  chainId: number;
  isSui: boolean;
  owner: string | null | undefined;
  notes: readonly WithdrawSpendabilityNote[];
}): string {
  const activeNotes = params.notes
    .filter((note) => isActiveStatus(note.status))
    .map((note) => [
      String(note.commitment),
      String(note.label),
      note.aspApproved === true ? 'approved' : note.aspApproved === false ? 'rejected' : 'pending',
    ] as const)
    .sort(([commitmentA, labelA, verdictA], [commitmentB, labelB, verdictB]) => {
      const commitmentOrder = commitmentA.localeCompare(commitmentB);
      if (commitmentOrder !== 0) return commitmentOrder;
      const labelOrder = labelA.localeCompare(labelB);
      return labelOrder !== 0 ? labelOrder : verdictA.localeCompare(verdictB);
    });

  return JSON.stringify([
    params.chainId,
    params.isSui ? 'sui' : 'evm',
    (params.owner ?? '').toLowerCase(),
    activeNotes,
  ]);
}

/**
 * Sui stores ASP membership per note. Unknown is pending, not spendable: the
 * proof needs a membership path just like EVM, so optimistic pre-flag behavior
 * must not seed Max or Review with an unproved note.
 */
export function partitionSuiWithdrawNotes<
  T extends { status: unknown; aspApproved?: boolean },
>(notes: readonly T[]): { approvedNotes: T[]; approvalPending: boolean } {
  const active = notes.filter((note) => String(note.status).toLowerCase() === 'active');
  return {
    approvedNotes: active.filter((note) => note.aspApproved === true),
    approvalPending: active.some((note) => note.aspApproved === undefined),
  };
}

/** Null means the current key has not resolved yet; an empty Set is resolved zero. */
export function resolveWithdrawSpendableCommitments(
  resolution: WithdrawSpendabilityResolution | null,
  currentKey: string,
): Set<string> | null {
  return resolution?.key === currentKey ? resolution.commitments : null;
}
