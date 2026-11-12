/** Describe the shared payload, never assume all request formats hide a wallet. */
export function paymentRequestRecipientLabel(request: { recipientAddress?: string }): string {
  const address = request.recipientAddress;
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'Not included in link';
}
