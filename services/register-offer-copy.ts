// "Register this wallet now?" after a claim too small to cover the fee
// (DEV-493). The claim refusal itself is unchanged and sends nothing; this is
// offered beside it only when the wallet holds the gas to register itself.
//
// The copy has to be explicit that registering does NOT claim this payment,
// or a user who registers reads the payment as received.

export const REGISTER_OFFER_TITLE = 'Register this wallet now?';

export function registerOfferBody(gasText: string | null): string {
  const cost = gasText ? ` It costs about ${gasText} in gas.` : '';
  return `This payment is too small to claim at today's fees, but registering means future payments arrive directly and can be claimed or found automatically.${cost} Registering does not claim this payment. It stays saved on this device, so you can claim it when fees drop.`;
}

export const REGISTER_OFFER_DONE =
  'Registered. Future payments to this wallet arrive directly. This payment stays saved on this device to claim later.';
