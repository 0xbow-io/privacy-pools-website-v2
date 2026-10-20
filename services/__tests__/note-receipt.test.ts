import { describe, test, expect, mock } from 'bun:test';

// config/env transitively pulls react-native (unparseable under bun) — stub
// the one RN symbol it needs, the same leak-safe way accounting-export.test.ts
// does. (Stubbing '@/config/env' itself leaks a gutted env into every later
// test file in the process — never do that.)
mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));
// Pin the SAME env accounting-export.test.ts pins: config/env is evaluated
// once per process, so whichever test file triggers the first import decides
// the values every later golden test sees — they must agree.
process.env.EXPO_PUBLIC_PAY_URL_BASE = 'https://pay.example.test';
process.env.EXPO_PUBLIC_TEST_MODE = 'true';

const {
  encodeNoteReceiptForUrl,
  decodeNoteReceiptFromUrl,
  extractNoteReceiptEncoded,
} = await import('@/services/note-receipt');
type NoteReceipt = import('@/services/note-receipt').NoteReceipt;

const NOTE = {
  commitment: '0xabababababababababababababababababababababababababababababababab',
  value: '0xde0b6b3a7640000',
  tokenId: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  ownerAddress: '0x1111111111111111111111111111111111111111',
} as unknown as NoteReceipt['notes'][number];

describe('note-receipt envelope', () => {
  test('round-trips owner and chainId through encode/decode', () => {
    const receipt: NoteReceipt = {
      notes: [NOTE],
      syncCursor: '0x0',
      owner: '0x1111111111111111111111111111111111111111',
      chainId: 4114,
    };
    const decoded = decodeNoteReceiptFromUrl(encodeNoteReceiptForUrl(receipt));
    expect(decoded).not.toBeNull();
    expect(decoded!.chainId).toBe(4114);
    expect(decoded!.owner).toBe('0x1111111111111111111111111111111111111111');
    expect(decoded!.notes).toHaveLength(1);
  });

  test('legacy receipts without an envelope still decode, with no invented fields', () => {
    const decoded = decodeNoteReceiptFromUrl(
      encodeNoteReceiptForUrl({ notes: [NOTE], syncCursor: '0x0' }),
    );
    expect(decoded).not.toBeNull();
    expect(decoded!.chainId).toBeUndefined();
    expect(decoded!.owner).toBeUndefined();
  });

  test('rejects malformed envelope fields instead of trusting them', () => {
    // Attacker-controllable input: a bogus chainId type or a non-hex owner
    // must be DROPPED (the notes still import under legacy rules).
    const tampered = {
      notes: [NOTE],
      syncCursor: '0x0',
      chainId: '4114', // string, not number
      owner: 'not-hex',
    } as unknown as NoteReceipt;
    const decoded = decodeNoteReceiptFromUrl(encodeNoteReceiptForUrl(tampered));
    expect(decoded).not.toBeNull();
    expect(decoded!.chainId).toBeUndefined();
    expect(decoded!.owner).toBeUndefined();
  });

  test('extractNoteReceiptEncoded pulls the payload out of a full share URL', () => {
    const encoded = encodeNoteReceiptForUrl({ notes: [NOTE], syncCursor: '0x0', chainId: 1 });
    const url = `https://pay.example.com/import-note/${encoded}?utm=x`;
    const extracted = extractNoteReceiptEncoded(url);
    expect(extracted).toBe(encoded);
    expect(decodeNoteReceiptFromUrl(extracted!)!.chainId).toBe(1);
  });

  test('buildSentReceiptUrl rebuilds a decodable receipt from audit disclosures', async () => {
    const { buildSentReceiptUrl } = await import('@/services/note-receipt');
    const disclosure = {
      chainId: 11155111,
      txHash: '0xfeed',
      commitment: '0xabababababababababababababababababababababababababababababababab',
      ownerAddress: '0x1111111111111111111111111111111111111111',
      noteSecret: '0xc4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4',
      tokenId: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      value: '0xde0b6b3a7640000',
      label: '0x1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a',
    };
    const url = buildSentReceiptUrl([disclosure as never]);
    expect(url).not.toBeNull();
    expect(url!).toContain('/import-note/');
    const decoded = decodeNoteReceiptFromUrl(extractNoteReceiptEncoded(url!)!);
    expect(decoded).not.toBeNull();
    expect(decoded!.chainId).toBe(11155111);
    expect(decoded!.owner).toBe(disclosure.ownerAddress as never);
    expect(decoded!.notes).toHaveLength(1);
    expect(decoded!.notes[0].commitment).toBe(disclosure.commitment as never);
    expect((decoded!.notes[0] as { noteSecret?: string }).noteSecret).toBe(disclosure.noteSecret);
    // The EXACT key set of a send-time link: the note preimage the recipient
    // needs and nothing else. No viewing or spending key material, ever
    // (Pat, 2026-09-16). The recovered form is pinned in note-receipt-shape.test.ts.
    expect(Object.keys(decoded!).sort()).toEqual(['chainId', 'notes', 'owner', 'syncCursor']);
    expect(Object.keys(decoded!.notes[0]).sort()).toEqual([
      'commitment', 'createdAtBlock', 'isOwned', 'label', 'noteSecret', 'ownerAddress', 'spentAtBlock', 'status', 'tokenId', 'txHash', 'value',
    ]);
    // Empty disclosure list has no receipt to rebuild.
    expect(buildSentReceiptUrl([])).toBeNull();
  });
});
