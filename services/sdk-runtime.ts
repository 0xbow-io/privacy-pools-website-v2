// One async entry keeps shared SDK dependencies out of the initial web bundle.
// Application callers import this module dynamically; workers keep their own entry.
export * from './sdk-setup';
export { createPoolSession } from './pool-session-service';
export type { CreatePoolSessionParams } from './pool-session-service';
export { utils, PaymentRequestStorageAdapter, MAX_BATCH, selectNotesForFullWithdraw, CryptoService } from '@privacy-pools-v2/sdk';
// Thrown by the relayed-transfer recipient builder exactly as prepareTransfer threw them.
export { PaymentRequestExpired, RecipientViewingKeyUnregistered } from '@privacy-pools-v2/sdk';
// The redeposit leg of a conversion into a yield pool: sizes the shares from
// the swap-output budget and encodes the share's PPRouter deposit. Reached
// through this module so services keep the SDK (and snarkjs) off page load.
export { prepareYieldSwapDeposit } from '@privacy-pools-v2/sdk';
export { buildPoseidon, buildBabyjub } from 'circomlibjs';
export { groth16 } from 'snarkjs';
// Yield earned (hooks/use-yield-earned.ts): reduces the event snapshot PoolsProvider
// already holds to the pool events the SDK's compute reads. No I/O.
export { yieldEarnedEventsFromSnapshot } from '@privacy-pools-v2/sdk';
// Points (hooks/use-points.ts): pure accrual over the local note set. No I/O.
export { computePoints, epochParamsFromRateLeaves, liveEpochParams } from '@privacy-pools-v2/sdk';
