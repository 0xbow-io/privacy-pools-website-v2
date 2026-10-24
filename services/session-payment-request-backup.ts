import { z } from 'zod';
import { decodePaymentRequestPayloadFromUrl } from '@/services/payment-request-codec';
import type { SessionPaymentRequest } from '@/services/session-payment-requests';

const address = z.string().regex(/^0x[\da-f]{40}$/i).transform((value) => value.toLowerCase());
const recordSchema = z.object({
  requestId: z.string().regex(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i),
  chainId: z.number().int().positive().safe(),
  owner: address,
  tokenAddress: address,
  amount: z.string().regex(/^0x[\da-f]+$/i),
  createdAtMs: z.number().int().nonnegative().max(8.64e15),
  payLink: z.string().nullable(),
  signed: z.boolean(),
});

/** Validate the whole batch before importing anything. Links are decoded locally. */
export function parseSessionRequestBackup(value: unknown, owner: string): SessionPaymentRequest[] {
  const parsed = z.array(recordSchema).safeParse(value);
  if (!parsed.success) throw new Error('Payment request backup contains invalid session requests.');
  for (const record of parsed.data) {
    if (record.owner !== owner.toLowerCase()) {
      throw new Error('This payment request backup belongs to another account. Sign in to that account to import it.');
    }
    if (record.payLink === null) continue;
    let matches = false;
    try {
      const url = new URL(record.payLink);
      const encoded = (url.pathname + url.hash).match(/\/pay[/#]([A-Za-z0-9_-]+)$/)?.[1];
      if ((url.protocol === 'http:' || url.protocol === 'https:') && encoded) {
        const payload = decodePaymentRequestPayloadFromUrl(encoded);
        matches = payload.kind === 'ppv2-payment-request' && payload.version === 2
          && payload.requestId.toLowerCase() === record.requestId.toLowerCase()
          && payload.chainId === record.chainId
          && payload.recipientAddress.toLowerCase() === record.owner
          && payload.tokenId.toLowerCase() === record.tokenAddress
          && BigInt(payload.amount) === BigInt(record.amount)
          && !!payload.signature === record.signed;
      }
    } catch { /* Invalid links fail the batch, rather than restoring a broken row. */ }
    if (!matches) throw new Error('A payment request link does not match its backup record.');
  }
  return parsed.data;
}

export function sessionRequestKey(record: SessionPaymentRequest): string {
  return `${record.owner.toLowerCase()}:${record.chainId}:${record.requestId.toLowerCase()}`;
}
