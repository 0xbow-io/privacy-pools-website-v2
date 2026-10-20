// The destination half of a cross-chain reshield session, as a pure mapping.
//
// It lives on its own, away from pool-session-service, for one reason: the SDK
// builds its `reshieldCrosschain` delegate only when `destinationChainId` AND
// `destinationEntrypointInteractor` are BOTH present, and ignores a lone chain
// id. A session built with one but not the other looks fine and then throws
// "ReshieldCrosschain is not available" at call time, deep inside a money flow.
// Keeping the both-or-neither rule in one testable function means a refactor
// cannot silently drop half of it (kimi's review of 5b8a88e).

/** The keys a PoolSessionConfig needs for flow 4, or nothing at all. */
export type ReshieldDestinationKeys<T, Y> =
  | {
    destinationChainId: number;
    destinationEntrypointInteractor: T;
    destinationYieldDepositTargets?: Y[];
  }
  | Record<string, never>;

/**
 * Spread the result into a PoolSessionConfig. Either both required keys appear
 * or neither does, whatever the inputs.
 *
 * `yieldDepositTargets` is the destination chain's share targets (a
 * `session.yields` array from a session built FOR that chain). With them the
 * SDK funds a share on the far side through its router
 * (`yieldDepositTargetFor` in PoolSessionReshieldCrosschain); without them the
 * only destination call it can make is `Entrypoint.deposit`, which no share
 * pool accepts.
 *
 * GROUNDWORK, not yet load-bearing (2026-09-22). Passing these is necessary for
 * a cross-chain reshield into a share and is not sufficient, so the UI still
 * refuses share targets on a bridged deposit. The missing half is in
 * `runReshieldCrosschain`: that wrapper builds the destination leg itself with
 * `destinationSession.prepareDeposit`, a plain Entrypoint deposit, rather than
 * going through the SDK's `PoolSessionReshieldCrosschain`, which is the code
 * that reads these targets (`yieldDepositTargetFor`). Until the wrapper grows a
 * yield branch, offering ppUSDT on BNB as a bridged target would produce a
 * deposit no share pool accepts, at the END of a bridged transfer.
 */
export function buildReshieldDestinationKeys<T, Y>(
  destination: { chainId: number } | undefined,
  entrypointInteractor: T | undefined | null,
  yieldDepositTargets?: readonly Y[] | null,
): ReshieldDestinationKeys<T, Y> {
  if (!destination || entrypointInteractor === undefined || entrypointInteractor === null) return {};
  return {
    destinationChainId: destination.chainId,
    destinationEntrypointInteractor: entrypointInteractor,
    // Copied, not aliased: the SDK's field is mutable and ours is readonly, and
    // a shared array would let one side's change reach the other's.
    ...(yieldDepositTargets && yieldDepositTargets.length > 0
      ? { destinationYieldDepositTargets: [...yieldDepositTargets] }
      : {}),
  };
}
