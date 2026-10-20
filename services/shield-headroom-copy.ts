/**
 * The "leave room for …" clause shown when a shield amount fits the wallet
 * balance but not the balance net of what the deposit charges on top.
 *
 * Name only what is actually charged. The vetting fee is zero on some assets
 * (prod yield pools such as ppUSDC/ppUSDT/ppETH, where the yield cut is the
 * revenue; Sepolia ETH), and telling someone to leave room for a fee that
 * does not exist is the kind of fee copy that gets reported as wrong. Gas
 * only applies when the pay token is the chain's native coin (an ERC-20 pay
 * token funds gas from a different balance). Cross-pay shields (flow 1,
 * swap-into-deposit) take the vetting fee out of the CONVERTED amount, so only
 * gas is on the pay side.
 *
 * Shared by the hub Shield tab and the deposit modal so the two never drift.
 */
export type ShieldHeadroomInputs = {
  /** Vetting fee of the DEPOSIT asset in basis points; null/undefined while loading. */
  vettingFeeBps: number | null | undefined;
  /** Flow 1: the pay token is swapped into the pool asset by the route. */
  crossPayShield: boolean;
  /** The pay token is the chain's native coin, so gas comes out of the same balance. */
  payIsNative: boolean;
};

export function shieldHeadroomRoomText({ vettingFeeBps, crossPayShield, payIsNative }: ShieldHeadroomInputs): string {
  const room = [
    !crossPayShield && vettingFeeBps != null && vettingFeeBps > 0 ? 'the vetting fee' : null,
    payIsNative ? 'gas' : null,
  ].filter((part): part is string => part !== null);
  if (room.length === 2) return `${room[0]} and ${room[1]}`;
  // Nothing named would still leave the sentence pointing at a real cost:
  // the reserve that produced the headroom is the gas reserve.
  return room[0] ?? 'gas';
}
