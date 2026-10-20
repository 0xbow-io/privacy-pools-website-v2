// A row action (Withdraw, Exit, Export Note) acts on the note's own chain. A
// row on another chain than the selected one switches there first, and the
// action opens only once the selection and the session chain have moved AND
// the SDK has let go of the previous chain's session: the modals read the
// chain when they render, so a callback captured before the switch would act
// on the old chain, and one that runs while the old session is still being
// torn down would start initializing against a session about to be dropped.
// This decides, for a pending action and the latest committed state, whether
// to wait, open it, or drop it.
//
// PURE module (no react-native imports) so it is bun-testable.

/** A switch that commits but never settles must not open a modal much later. */
export const ROW_ACTION_SWITCH_WINDOW_MS = 30_000;

export type PendingRowAction<K extends string = string> = {
  kind: K;
  chainId: number;
  /** When the switch committed, unix ms. */
  at: number;
};

export function pendingRowActionStep(
  pending: PendingRowAction | null,
  current: {
    selectedChainId: number;
    sessionChainId: number;
    /** The chain of the SDK session that is built (EVM), or null when there
     *  is none: before keys, after a teardown, or on a non-EVM target. */
    sdkSessionChainId: number | null;
    /** An SDK session is being built. */
    sdkInitializing: boolean;
    /** None is built or building yet, but one is about to be rebuilt without
     *  a prompt (sdk-provider `sessionResuming`). Opening now would read the
     *  gap as signed out and flash the sign-in dialog. */
    sdkResuming?: boolean;
  },
  now: number,
): 'none' | 'wait' | 'open' | 'drop' {
  if (!pending) return 'none';
  if (now - pending.at > ROW_ACTION_SWITCH_WINDOW_MS) return 'drop';
  if (current.selectedChainId !== pending.chainId || current.sessionChainId !== pending.chainId) return 'wait';
  if (current.sdkInitializing || current.sdkResuming) return 'wait';
  if (current.sdkSessionChainId !== null && current.sdkSessionChainId !== pending.chainId) return 'wait';
  return 'open';
}
