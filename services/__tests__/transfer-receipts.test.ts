import { describe, expect, test } from 'bun:test';

import { buildRecipientReceipts, receiptsTotal } from '@/services/transfer-receipts';
import type { Address, Hash, Hex } from '@/services/sdk-types';

const RECIPIENT = '0xBbBBbbBBbbbbBBbbBBbbBBbBbBbbBBbbBBbbBBbB' as Address;
const TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as Address;
const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as Address;
const h = (c: string) => `0x${c.repeat(64)}` as Hash;

// SDK-boundary shape: what prepareTransfer's executeOptions carries after a
// TWO-lineage selection (e.g. inputs A=[8,1,1], B=[7,7], C=[7,7], target 28 →
// the exact search picks B+C and the SDK emits one 14-unit recipient note per
// lineage). The receipts must keep BOTH notes with their own values.
const twoNotes = [
  {
    commitment: h('1'), label: h('a'), noteAddressHash: h('2'),
    value: '0xe' as Hex, tokenId: TOKEN, ownerAddress: ZERO_ADDR,
    noteSecret: '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
  },
  {
    commitment: h('3'), label: h('b'), noteAddressHash: h('4'),
    value: '0xe' as Hex, tokenId: TOKEN, ownerAddress: ZERO_ADDR,
    noteSecret: undefined,
  },
];

describe('buildRecipientReceipts (SDK boundary)', () => {
  test('keeps every recipient note with its OWN value on a two-lineage transfer', () => {
    const map = new Map<Hash, Hex>([
      [h('2'), h('5') as unknown as Hex],
      [h('4'), h('6') as unknown as Hex],
    ]);
    const { receipts, discoverable } = buildRecipientReceipts(
      twoNotes,
      { noteSecretsMap: map },
      { recipientAddress: RECIPIENT, tokenId: TOKEN },
    );
    expect(discoverable).toBe(false); // no publicViewingKey → out-of-band
    expect(receipts).toHaveLength(2);
    // Per-note SDK values preserved (14 + 14), never the 28 total.
    expect(receipts.map((r) => r.value)).toEqual(['0xe', '0xe']);
    expect(receiptsTotal(receipts)).toBe(28n);
    // Secrets resolved from the map when the enriched field is a zero
    // placeholder or missing.
    expect(receipts[0].noteSecret).toBe(h('5') as unknown as Hex);
    expect(receipts[1].noteSecret).toBe(h('6') as unknown as Hex);
    // The SDK's EMPTY_ADDRESS owner is replaced with the real recipient.
    expect(receipts.every((r) => r.ownerAddress === RECIPIENT)).toBe(true);
  });

  test('prefers a real enriched secret over the map', () => {
    const enriched = [{ ...twoNotes[0], noteSecret: h('9') as unknown as Hex }];
    const map = new Map<Hash, Hex>([[h('2'), h('5') as unknown as Hex]]);
    const { receipts } = buildRecipientReceipts(
      enriched,
      { noteSecretsMap: map },
      { recipientAddress: RECIPIENT, tokenId: TOKEN },
    );
    expect(receipts[0].noteSecret).toBe(h('9') as unknown as Hex);
  });

  test('a note with no resolvable secret keeps noteSecret null (blind path)', () => {
    const { receipts } = buildRecipientReceipts(
      [twoNotes[1]],
      {},
      { recipientAddress: RECIPIENT, tokenId: TOKEN },
    );
    expect(receipts[0].noteSecret).toBeNull();
  });

  test('classifies discoverable by publicViewingKey presence', () => {
    const { discoverable } = buildRecipientReceipts(
      [twoNotes[0]],
      { publicViewingKey: '0x1234' },
      { recipientAddress: RECIPIENT, tokenId: TOKEN },
    );
    expect(discoverable).toBe(true);
  });

  test('receiptsTotal exposes the sum the caller must check against the amount', () => {
    const { receipts } = buildRecipientReceipts(
      twoNotes,
      {},
      { recipientAddress: RECIPIENT, tokenId: TOKEN },
    );
    expect(receiptsTotal(receipts)).toBe(28n);
    expect(receiptsTotal([])).toBe(0n);
  });
});
