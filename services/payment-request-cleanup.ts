// DEV-515: the unshared-request cleanup rule, kept free of react-native imports
// so bun tests can reach it.

/**
 * `state` without the request `paymentId`, or null when it holds no such
 * request (so a caller writes nothing). Pure, so the DEV-515 cleanup rule is
 * tested without the react-native storage around it.
 */
export function withoutPaymentRequest<T extends { requests: ReadonlyArray<{ paymentId: string }> }>(
  state: T | null | undefined,
  paymentId: string,
): T | null {
  if (!state) return null;
  const wanted = paymentId.toLowerCase();
  const remaining = state.requests.filter((request) => request.paymentId.toLowerCase() !== wanted);
  return remaining.length === state.requests.length ? null : { ...state, requests: remaining };
}
