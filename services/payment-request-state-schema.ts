import { z } from 'zod';
import type { PaymentRequestServiceState } from '@privacy-pools-v2/sdk';

// v2.0 migration: the SDK's `external.ts` curates its RUNTIME export surface
// and only re-exports schemas as TYPES (`export type * from "./internal.js"`),
// so `PaymentRequestServiceStateSchema` exists in index.d.ts but is undefined
// at runtime in the v2.0 bundle. This is a faithful local mirror of
// packages/sdk/src/schemas/PaymentRequest.ts @ b2a37959 — keep it in sync if
// the SDK's stored payment-request shape changes (the SDK's own
// PaymentRequestStorageAdapter.getState() still validates with the real
// schema, so any divergence surfaces there too).

const HexSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]+$/, 'Must represent a valid hexadecimal integer value with 0x prefix');

const AddressSchema = HexSchema.refine((val) => val.slice(2).length === 40, {
  message: 'Must be a 20-byte Ethereum address (40 hex chars)',
});

// ARCHIVED (SDK b2a37959, finding #600): a recipient-controlled terminal
// state, excluded from the SDK's scannable set. This app never archives, but a
// record archived by another client must still validate here rather than fail
// the whole state blob.
const PaymentRequestStatusSchema = z.enum(['OPEN', 'FULFILLED', 'ARCHIVED']);

// Accepts a real Map<Hex, Hex>, a plain object Record<Hex, Hex>, or an array
// of [Hex, Hex] entries and normalizes to Map<Hex, Hex> — mirrors the SDK's
// NoteSecretsMapCodec (JSON-backed persistence and QR/link transports leave
// different shapes).
const NoteSecretsMapCodec = z
  .union([
    z.map(HexSchema, HexSchema),
    z.record(HexSchema, HexSchema),
    z.array(z.tuple([HexSchema, HexSchema])),
  ])
  .transform((input) => {
    if (input instanceof Map) return input as Map<`0x${string}`, `0x${string}`>;
    if (Array.isArray(input)) return new Map(input) as Map<`0x${string}`, `0x${string}`>;
    return new Map(Object.entries(input)) as Map<`0x${string}`, `0x${string}`>;
  })
  .refine((m) => m.size > 0, {
    message: 'noteSecretsMap must contain at least one slot',
  });

const PaymentRequestSchema = z.object({
  paymentId: HexSchema,
  noteAddressHashes: z.array(HexSchema).min(1),
  amount: HexSchema,
  tokenId: AddressSchema,
  tag: HexSchema,
  paymentPubKey: HexSchema,
  // The SDK's deadline (unix ms). Declared so this mirror does not strip it:
  // a backup, a restore or a rebuilt share link would otherwise lose it and
  // the payer could no longer see the request expire.
  expiresAt: HexSchema.optional(),
});

const StoredPaymentRequestRecordSchema = PaymentRequestSchema.extend({
  noteSecretsMap: NoteSecretsMapCodec,
  recipientAddress: AddressSchema,
  status: PaymentRequestStatusSchema,
  createdAt: HexSchema,
  fulfilledByCommitments: z.array(HexSchema),
  // SDK b2a37959: slots consumed by a GENUINE match, as opposed to
  // fulfilledByCommitments' audit trail of everything discovered (a 0-value or
  // duplicate-slot phantom lands in the latter only). `.default([])` mirrors the
  // SDK so pre-#600 records stay importable — and the field must be declared
  // here or this mirror would strip an incoming record's consumed slots and
  // re-open them.
  consumedSlots: z.array(HexSchema).default([]),
  // SDK: the scan-covered time past the deadline at which the request left the
  // scan set. Kept for the same reason as expiresAt above.
  scanRetiredAt: HexSchema.optional(),
  // Divergence from the SDK's runtime schema (which strips this field): a
  // pre-v2.0 record's stored paymentPrivKey is a RANDOM ephemeral key the
  // current SDK cannot re-derive — it must survive ppv2's own validation in
  // the migration/backup/restore paths or old open links become
  // undiscoverable. v2.0-created records never carry it.
  paymentPrivKey: HexSchema.optional(),
});

/** Validates the full persisted payment-request state blob. */
export const PaymentRequestServiceStateSchema = z.object({
  requests: z.array(StoredPaymentRequestRecordSchema),
}) as unknown as z.ZodType<PaymentRequestServiceState>;
