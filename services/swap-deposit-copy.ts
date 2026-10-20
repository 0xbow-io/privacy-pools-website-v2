/**
 * Copy for the swap + deposit consent card (DEV-436). Pure, so a test can pin
 * that both consent cards (the hub's inline one and the deposit modal's) say it.
 *
 * A LI.FI route quotes with a slippage buffer. What the route does not use is
 * returned to the paying wallet in the token it bought, so the wallet preview
 * reads "-28.37 USDC, +0.325 USDT" and looks like a loss. It is not: the
 * shielded amount on the card goes into the pool, and the rest comes back.
 */
export const SWAP_DEPOSIT_REFUND_NOTE =
  'Your wallet may also show a small amount coming back in the token you shield. That is unused slippage buffer returned to you. The amount above goes into the pool.';
