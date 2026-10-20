/**
 * Must switching to `targetChainId` leave the pool page first?
 *
 * A pool detail page pins the selection to ITS chain (pool-page-content's
 * effect), so switching EVM chains while it is open fights it: two wallet
 * prompts and a silently reverted choice. Home is chain-agnostic, so the switch
 * goes there first. Shared by the header selector and the pool card's own
 * selector, which skipped it (DEV-453).
 *
 * Pure: the caller passes the target's chain type, so this stays importable
 * where config/chains is not (bun tests).
 */
export function mustLeavePoolPageToSwitch(args: {
  targetChainId: number;
  targetChainType: string | undefined;
  currentChainId: number;
  pathname: string;
}): boolean {
  return args.targetChainType === 'evm'
    && args.targetChainId !== args.currentChainId
    && args.pathname.startsWith('/chains/');
}
