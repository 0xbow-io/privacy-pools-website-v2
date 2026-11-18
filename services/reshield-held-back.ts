/**
 * What a reshield holds back between the swap's minimum output and the new
 * note, in the SWAP OUTPUT's units (the underlying for a share target).
 *
 * The SDK sizes the deposit from `minOutput * 99%` and the router sweeps the
 * rest to the relayer as dust (DEV-603), so on a stablecoin pair this is about
 * 1% of the swap. It was never a line on Review, which is why the screen
 * stopped adding up (DEV-822): minimum output, then a note about 1% smaller,
 * and nothing between them.
 *
 * `noteValueWei` is in the DEPOSIT's units. For a yield share that is shares,
 * so it is priced through `assetsPerShare` (underlying units one whole share
 * redeems to) before it is compared with an underlying-denominated output.
 * For a plain pool asset the deposit and the swap output are the same token and
 * `share` is left out. The vetting fee is reported separately and is zero for a
 * share, where the router takes it inside the note's sizing.
 *
 * Kept free of imports so it can be tested without the app's config graph.
 */
export function reshieldHeldBack(params: {
  minOutputWei: bigint;
  noteValueWei: bigint;
  vettingFeeWei: bigint;
  /** Set only when the note is a yield share. */
  share?: { assetsPerShare: bigint; shareDecimals: number };
}): bigint {
  const noteInSwapUnits = params.share
    ? (params.noteValueWei * params.share.assetsPerShare) / 10n ** BigInt(params.share.shareDecimals)
    : params.noteValueWei;
  const held = params.minOutputWei - noteInSwapUnits - params.vettingFeeWei;
  return held > 0n ? held : 0n;
}
