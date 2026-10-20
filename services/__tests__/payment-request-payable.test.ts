import { describe, expect, test } from 'bun:test';
import { privateKeyToAccount } from 'viem/accounts';

import {
  assertPaymentRequestPayable,
  getPaymentRequestSigningDomain,
  getPaymentRequestSigningMessage,
  parsePaymentRequestPayload,
  PAYMENT_REQUEST_SIGNING_TYPES,
  PAYMENT_REQUEST_V2_SIGNING_TYPES,
  type PaymentRequestPayload,
  type PaymentRequestPayloadV2,
  type PaymentRequestPayloadV3,
} from '@/services/payment-request-codec';
import type { Hash, Hex, PublicKey, Secret } from '@/services/sdk-types';

// A real signer, so these are genuine EIP-712 signatures — not stubs. The whole
// point of the gate is verifying a real signature against real fields, and a
// mock would test the mock.
const account = privateKeyToAccount(`0x${'11'.repeat(32)}` as Hex);
const CHAIN = 11155111;

const baseV2 = (): Omit<PaymentRequestPayloadV2, 'signature'> => ({
  kind: 'ppv2-payment-request',
  version: 2,
  requestId: 'req-1',
  chainId: CHAIN,
  recipientAddress: account.address as Hex,
  recipientViewingPubKey: `0x${'ab'.repeat(32)}` as Hex,
  tokenId: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as Hex,
  amount: '0x2386f26fc10000' as Hex,
  createdAt: '2026-08-11T00:00:00.000Z',
});

async function signV2(payload: Omit<PaymentRequestPayloadV2, 'signature'>, sellerName = ''): Promise<PaymentRequestPayloadV2> {
  const signature = await account.signTypedData({
    domain: getPaymentRequestSigningDomain(payload.chainId),
    types: PAYMENT_REQUEST_V2_SIGNING_TYPES,
    primaryType: 'DiscoverablePaymentRequest',
    message: getPaymentRequestSigningMessage(payload as PaymentRequestPayloadV2, sellerName),
  });
  return { ...payload, signature: { signer: account.address, signature, signedAt: payload.createdAt, sellerName } };
}

describe('assertPaymentRequestPayable', () => {
  // The property that matters: a validly signed request is payable, and every
  // signed field is under the seal.
  test('a validly signed v2 request is payable and reports signed', async () => {
    const signed = await signV2(baseV2());
    expect(await assertPaymentRequestPayable(signed)).toEqual({ payable: true, signed: true });
  });

  // THE BUG: swap the recipient after signing. This is a payment redirected to
  // an attacker; it MUST be refused, not merely flagged.
  test('a request with a swapped RECIPIENT is refused as tampered', async () => {
    const signed = await signV2(baseV2());
    const tampered: PaymentRequestPayloadV2 = {
      ...signed,
      recipientAddress: '0x000000000000000000000000000000000000dEaD' as Hex,
    };
    expect(await assertPaymentRequestPayable(tampered)).toEqual({ payable: false, reason: 'tampered' });
  });

  // Swap only the key: the note becomes unspendable by anyone. Also refused.
  test('a request with a swapped VIEWING KEY is refused as tampered', async () => {
    const signed = await signV2(baseV2());
    const tampered: PaymentRequestPayloadV2 = {
      ...signed,
      recipientViewingPubKey: `0x${'cd'.repeat(32)}` as Hex,
    };
    expect((await assertPaymentRequestPayable(tampered)).payable).toBe(false);
  });

  test('a swapped AMOUNT is refused (the amount is under the seal too)', async () => {
    const signed = await signV2(baseV2());
    const tampered: PaymentRequestPayloadV2 = { ...signed, amount: '0xde0b6b3a7640000' as Hex };
    expect((await assertPaymentRequestPayable(tampered)).payable).toBe(false);
  });

  // Unsigned is unverified BY DESIGN — the sender chose not to sign. It stays
  // payable so the whole unsigned flow keeps working; callers label it.
  test('an UNSIGNED request stays payable, reported as not signed', async () => {
    expect(await assertPaymentRequestPayable(baseV2())).toEqual({ payable: true, signed: false });
  });

  // v1 predates signing entirely.
  test('a v1 request is payable (no signing existed)', async () => {
    const v1 = {
      kind: 'ppv2-payment-request', version: 1, requestId: 'r', chainId: CHAIN,
      recipientAddress: account.address, tokenId: '0xEee', amount: '0x1',
      noteAddressHash: `0x${'0'.repeat(64)}`, createdAt: '2026-08-11T00:00:00.000Z',
    } as unknown as PaymentRequestPayload;
    expect((await assertPaymentRequestPayable(v1)).payable).toBe(true);
  });

  // A garbage signature (wrong length, non-hex) makes verifyTypedData throw.
  // An unreadable seal is not a valid one — it must be refused, not swallowed
  // into "payable".
  test('a malformed signature is refused, not treated as valid', async () => {
    const bad: PaymentRequestPayloadV2 = {
      ...baseV2(),
      signature: { signer: account.address, signature: '0xdeadbeef' as Hex, signedAt: '2026-08-11T00:00:00.000Z' },
    };
    expect(await assertPaymentRequestPayable(bad)).toEqual({ payable: false, reason: 'tampered' });
  });

  // Right signature bytes, wrong claimed signer: verification fails.
  test('a signature by a DIFFERENT signer than claimed is refused', async () => {
    const signed = await signV2(baseV2());
    const other = privateKeyToAccount(`0x${'22'.repeat(32)}` as Hex);
    const spoofed: PaymentRequestPayloadV2 = {
      ...signed,
      signature: { ...signed.signature!, signer: other.address },
    };
    expect((await assertPaymentRequestPayable(spoofed)).payable).toBe(false);
  });

  // The sellerName is part of the signed message, so tampering with it after
  // the fact also breaks the seal.
  test('a tampered sellerName is refused', async () => {
    const signed = await signV2(baseV2(), 'Alice');
    const spoofed: PaymentRequestPayloadV2 = {
      ...signed,
      signature: { ...signed.signature!, sellerName: 'Mallory' },
    };
    expect((await assertPaymentRequestPayable(spoofed)).payable).toBe(false);
  });
});

// v3 (SDK-native) requests take the OTHER verify branch, whose signed struct is
// a different set of fund-affecting fields (paymentPubKey + noteSecretsMapHash
// instead of a viewing key). kimi's round-1 note: the gate was only tested
// against v2. Prove the same protection holds on the v3 path — a tampered v3 is
// the same redirect-the-money attack.
describe('assertPaymentRequestPayable. V3 (SDK-native)', () => {
  const baseV3 = (): Omit<PaymentRequestPayloadV3, 'signature'> => ({
    kind: 'ppv2-sdk-payment-request',
    version: 1,
    chainId: CHAIN,
    recipientAddress: account.address as Hex,
    paymentId: `0x${'12'.repeat(32)}` as Hex,
    tag: `0x${'34'.repeat(32)}` as Hex,
    paymentPubKey: `0x${'ab'.repeat(32)}` as unknown as PublicKey,
    tokenId: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as Hex,
    amount: '0x2386f26fc10000' as Hex,
    noteSecretsMap: [[`0x${'aa'.repeat(32)}` as Hash, `0x${'bb'.repeat(32)}` as unknown as Secret]],
    createdAt: '2026-08-11T00:00:00.000Z',
  });

  async function signV3(payload: Omit<PaymentRequestPayloadV3, 'signature'>, sellerName = ''): Promise<PaymentRequestPayloadV3> {
    const signature = await account.signTypedData({
      domain: getPaymentRequestSigningDomain(payload.chainId),
      types: PAYMENT_REQUEST_SIGNING_TYPES,
      primaryType: 'PaymentRequest',
      message: getPaymentRequestSigningMessage(payload as PaymentRequestPayloadV3, sellerName),
    });
    return { ...payload, signature: { signer: account.address, signature, signedAt: payload.createdAt, sellerName } };
  }

  test('a validly signed v3 request is payable', async () => {
    const signed = await signV3(baseV3());
    expect(await assertPaymentRequestPayable(signed)).toEqual({ payable: true, signed: true });
  });

  test('a swapped recipient is refused', async () => {
    const signed = await signV3(baseV3());
    expect((await assertPaymentRequestPayable({
      ...signed, recipientAddress: '0x000000000000000000000000000000000000dEaD' as Hex,
    })).payable).toBe(false);
  });

  // paymentPubKey is v3's key field — the analogue of v2's viewing key.
  test('a swapped paymentPubKey is refused', async () => {
    const signed = await signV3(baseV3());
    expect((await assertPaymentRequestPayable({
      ...signed, paymentPubKey: `0x${'cd'.repeat(32)}` as unknown as PublicKey,
    })).payable).toBe(false);
  });

  // The note secrets are sealed via noteSecretsMapHash — swapping them redirects
  // which notes the payment funds.
  test('a swapped noteSecretsMap is refused', async () => {
    const signed = await signV3(baseV3());
    expect((await assertPaymentRequestPayable({
      ...signed,
      noteSecretsMap: [[`0x${'99'.repeat(32)}` as Hash, `0x${'88'.repeat(32)}` as unknown as Secret]],
    })).payable).toBe(false);
  });

  test('all v3 payment-execution fields are sealed', async () => {
    const signed = await signV3(baseV3());
    const tamperedCases: PaymentRequestPayloadV3[] = [
      { ...signed, chainId: 1 },
      { ...signed, recipientAddress: '0x000000000000000000000000000000000000dEaD' as Hex },
      { ...signed, paymentId: `0x${'11'.repeat(32)}` as Hex },
      { ...signed, tag: `0x${'22'.repeat(32)}` as Hex },
      { ...signed, paymentPubKey: `0x${'33'.repeat(32)}` as unknown as PublicKey },
      { ...signed, tokenId: '0x000000000000000000000000000000000000dEaD' as Hex },
      { ...signed, amount: '0xde0b6b3a7640000' as Hex },
      {
        ...signed,
        noteSecretsMap: [
          [`0x${'44'.repeat(32)}` as Hash, signed.noteSecretsMap[0][1]],
        ],
      },
    ];

    for (const tampered of tamperedCases) {
      expect(await assertPaymentRequestPayable(tampered)).toEqual({ payable: false, reason: 'tampered' });
    }
  });

  test('an unsigned v3 request stays payable', async () => {
    expect(await assertPaymentRequestPayable(baseV3() as PaymentRequestPayload)).toEqual({ payable: true, signed: false });
  });

  // Positive counterpart to the null-tampered case below: a genuine signed v3
  // LINK (parsed from JSON, not just an in-memory object) must still parse and
  // pay — the `=== undefined` / non-object-throw narrowing must not over-reject
  // a real seal on the wire.
  test('a genuine signed v3 link parses AND is payable', async () => {
    const signed = await signV3(baseV3());
    const payload = parsePaymentRequestPayload(JSON.stringify(signed));
    expect(await assertPaymentRequestPayable(payload)).toEqual({ payable: true, signed: true });
  });

  // codex round 2, HIGH: `null` is not absence. A tampered v3 LINK sets
  // signature:null to strip the seal while keeping the field. Before the fix
  // parseSignature coerced null → undefined and the gate paid it as "unsigned".
  test('a signed v3 link with signature:null (recipient tampered) is REJECTED', async () => {
    const signed = await signV3(baseV3());
    const parsed = JSON.parse(JSON.stringify(signed));
    parsed.recipientAddress = '0x000000000000000000000000000000000000dEaD';
    parsed.signature = null; // strip the seal on the wire
    expect(() => parsePaymentRequestPayload(JSON.stringify(parsed))).toThrow(/malformed/);
  });
});

// codex round 1, HIGH: the gate is airtight for well-formed in-memory objects,
// but the REAL attack arrives as a decoded LINK. The parser used to normalize a
// present-but-malformed signature to "unsigned" and let a signed request pose
// as v1 — both slipping past the gate as payable. These exercise the JSON path
// the earlier tests skipped.
describe('parse-path bypasses (the attack arrives as JSON)', () => {
  const validV2Json = async (): Promise<string> => {
    const signed = await signV2(baseV2());
    return JSON.stringify(signed);
  };

  test('a structurally-malformed signature REJECTS the link, not "unsigned"', async () => {
    const parsed = JSON.parse(await validV2Json());
    // Not even hex — fails parseSignature's shape check. Before the fix this
    // coerced to signature:undefined and the gate then said "unsigned, payable".
    parsed.signature.signature = 'not-a-signature';
    expect(() => parsePaymentRequestPayload(JSON.stringify(parsed))).toThrow(/malformed/);
  });

  // A signature that is well-formed HEX but cryptographically bogus is NOT the
  // parser's job — it passes the shape check and parses. The GATE refuses it.
  // This is the division of labour: parser validates shape, gate validates the
  // seal. Both must reject; neither alone is enough.
  test('a well-formed-but-bogus signature parses, then the gate refuses it', async () => {
    const parsed = JSON.parse(await validV2Json());
    parsed.signature.signature = '0xdeadbeef'; // valid hex, wrong bytes
    const payload = parsePaymentRequestPayload(JSON.stringify(parsed));
    expect((await assertPaymentRequestPayable(payload)).payable).toBe(false);
  });

  test('a signature object missing its signer rejects the link', async () => {
    const parsed = JSON.parse(await validV2Json());
    delete parsed.signature.signer;
    expect(() => parsePaymentRequestPayload(JSON.stringify(parsed))).toThrow(/malformed/);
  });

  // codex round 2, HIGH: JSON cannot carry `undefined`, so the on-the-wire way
  // to strip a seal is signature:null. Before the fix parseSignature treated
  // null as absence → undefined → the gate paid the tampered link as "unsigned".
  test('a signed v2 link with signature:null (recipient tampered) is REJECTED', async () => {
    const parsed = JSON.parse(await validV2Json());
    parsed.recipientAddress = '0x000000000000000000000000000000000000dEaD';
    parsed.signature = null; // seal stripped on the wire
    expect(() => parsePaymentRequestPayload(JSON.stringify(parsed))).toThrow(/malformed/);
  });

  // Defence in depth for the gate's own narrowing: a DIRECT in-memory v2 object
  // carrying signature:null (never through the parser) must NOT be waved through
  // as unsigned by `!signature`; the strict `=== undefined` check sends it to
  // verification, which refuses the unreadable seal as tampered.
  test('the gate refuses a direct v2 object whose signature is null', async () => {
    const nullSig = { ...baseV2(), signature: null } as unknown as PaymentRequestPayload;
    expect(await assertPaymentRequestPayable(nullSig)).toEqual({ payable: false, reason: 'tampered' });
  });

  test('a signed v2 relabelled version:1 with an attacker noteAddressHash is rejected', async () => {
    const parsed = JSON.parse(await validV2Json());
    parsed.version = 1;
    parsed.noteAddressHash = `0x${'de'.repeat(32)}`; // attacker-chosen fund routing
    // v1 fund-routing is unsigned; a v1 carrying a signature is a downgrade.
    expect(() => parsePaymentRequestPayload(JSON.stringify(parsed))).toThrow(/must not carry a signature/);
  });

  test('a genuinely valid signed link still parses AND is payable', async () => {
    const payload = parsePaymentRequestPayload(await validV2Json());
    expect(await assertPaymentRequestPayable(payload)).toEqual({ payable: true, signed: true });
  });

  test('a genuine unsigned link still parses and is payable', async () => {
    const payload = parsePaymentRequestPayload(JSON.stringify(baseV2()));
    expect(await assertPaymentRequestPayable(payload)).toEqual({ payable: true, signed: false });
  });

  // Defence in depth: a DIRECT in-memory v1 carrying a signature (never through
  // the parser) must still be refused by the gate itself.
  test('the gate refuses a direct v1 object that carries a signature', async () => {
    const v1WithSig = {
      kind: 'ppv2-payment-request', version: 1, requestId: 'r', chainId: CHAIN,
      recipientAddress: account.address, tokenId: '0xEee', amount: '0x1',
      noteAddressHash: `0x${'0'.repeat(64)}`, createdAt: '2026-08-11T00:00:00.000Z',
      signature: { signer: account.address, signature: '0x00', signedAt: 'x' },
    } as unknown as PaymentRequestPayload;
    expect(await assertPaymentRequestPayable(v1WithSig)).toEqual({ payable: false, reason: 'tampered' });
  });
});
