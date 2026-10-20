import { useEffect, useState } from 'react';

import { isPaymentRequestExpired, type PaymentRequestPayload } from '@/services/payment-request-codec';

// setTimeout fires at once for a delay past 2^31 - 1 ms, so a far deadline is
// waited for in steps.
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Whether a request's deadline has passed, re-evaluated when it passes, so a
 * page left open turns its Pay buttons off on time. A request with no known
 * deadline is never expired. The pay handlers check again on press; this only
 * drives what the page shows.
 */
export function usePaymentRequestExpired(request: PaymentRequestPayload | null | undefined): boolean {
  const expiresAt = request?.kind === 'ppv2-sdk-payment-request' ? request.expiresAt : undefined;
  const [tick, setTick] = useState(0);
  const expired = !!request && isPaymentRequestExpired(request);

  useEffect(() => {
    if (expiresAt === undefined || expired) return;
    let deadline: number;
    try {
      deadline = Number(BigInt(expiresAt));
    } catch {
      return;
    }
    // +1: expired means strictly past the deadline (same as the SDK).
    const wait = Math.min(Math.max(deadline - Date.now() + 1, 0), MAX_TIMER_MS);
    const timer = setTimeout(() => setTick((n) => n + 1), wait);
    return () => clearTimeout(timer);
  }, [expiresAt, expired, tick]);

  return expired;
}
