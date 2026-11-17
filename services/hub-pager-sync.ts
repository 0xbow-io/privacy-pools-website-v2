/**
 * The hub card is a horizontal pager with one page per tab, and the tab bar is
 * drawn from the selected action. Two sources of truth, so they can disagree:
 * the browser scrolls a clipped box to reveal a focused or edited field (the
 * Shield recipient input), and the pager then sits on the neighbouring page
 * (Withdraw) while the bar still says Shield.
 *
 * The selected action is the only truth. This returns the offset the pager
 * must be put back to, or null when it is already there or the user is mid
 * gesture (a drag or wheel pan is allowed to move it; the settle handler then
 * selects the page it lands on).
 */
export function pagerResyncTarget(input: {
  offsetX: number;
  actionIndex: number;
  stride: number;
  userScrolling: boolean;
}): number | null {
  const { offsetX, actionIndex, stride, userScrolling } = input;
  if (userScrolling || actionIndex < 0 || stride <= 0) return null;
  const target = actionIndex * stride;
  return Math.abs(offsetX - target) > 1 ? target : null;
}
