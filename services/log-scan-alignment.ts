/**
 * Shared block grid for log-scan start cursors.
 *
 * A client's raw sync cursor is a per-client fingerprint: passing it straight to
 * `eth_getLogs` (or to the ASP's `?since=`) tells that party roughly when this
 * client last synced, which re-identifies a returning client across IP changes
 * and narrows which events it cares about. Snapping every scan start onto a
 * shared grid means clients scanning the same region of history send the same
 * value, drawn from a small shared vocabulary.
 *
 * See `v2-monorepo/docs/PRIVACY_RPC_METADATA_AUDIT.md` §Residual, and
 * `ViemRPCInteractor.floorFromBlock` in the SDK — keep the two in step.
 */

/** Grid size. Matches the SDK's `LOG_SCAN_ALIGNMENT_BLOCKS` and the chunk size. */
export const LOG_SCAN_ALIGNMENT_BLOCKS = 10_000n;

/**
 * Snaps a scan start block down onto {@link LOG_SCAN_ALIGNMENT_BLOCKS}, never
 * going below `deploymentBlock`.
 *
 * Down, never up: widening a scan window can only re-deliver events, which
 * every consumer already tolerates (note discovery skips commitments already in
 * the NoteManager; leaf reconstruction is index-keyed; the bulk note index is
 * map-keyed). Aligning up would silently skip events.
 *
 * The deployment floor wins over the grid, so alignment never scans into empty
 * pre-deployment history.
 */
export function alignLogScanStart(fromBlock: bigint, deploymentBlock: bigint): bigint {
  const clamped = fromBlock < deploymentBlock ? deploymentBlock : fromBlock;
  const aligned = (clamped / LOG_SCAN_ALIGNMENT_BLOCKS) * LOG_SCAN_ALIGNMENT_BLOCKS;
  return aligned < deploymentBlock ? deploymentBlock : aligned;
}
