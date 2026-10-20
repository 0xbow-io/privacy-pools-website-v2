import { describe, expect, test } from 'bun:test';

import { previewNoteReceiptUrl } from '../note-receipt-preview';

/**
 * The receipt payload IS the claim secret. Every test here is one assertion in
 * different clothes: the preview must never be a usable receipt, and must never
 * echo back a string it did not recognise.
 *
 * The fixtures are built with the REAL encoding (base64url of
 * JSON.stringify(receipt)) rather than an invented-looking blob. The first
 * version of this file used a made-up payload, and that is exactly what hid the
 * bug it was supposed to catch: with a synthetic fixture, keeping "the first
 * eight characters" looked like it distinguished receipts. With real ones it is
 * obvious they are all identical.
 */
const encode = (receipt: unknown) => Buffer.from(JSON.stringify(receipt)).toString('base64url');
const receipt = (n: number, owner: string, chainId: number) => ({
  notes: [{ commitment: `0x${n.toString(16).padStart(64, '0')}`, noteSecret: `0x${(n * 7).toString(16)}` }],
  syncCursor: '0x0',
  owner,
  chainId,
});

describe('previewNoteReceiptUrl', () => {
  const PAYLOAD = encode(receipt(1, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1));
  const URL = `https://privacypools.com/import-note/${PAYLOAD}`;

  test('keeps the domain and path, shows none of the payload', () => {
    expect(previewNoteReceiptUrl(URL)).toBe('https://privacypools.com/import-note/…');
  });

  test('never contains any of the payload', () => {
    const shown = previewNoteReceiptUrl(URL);
    expect(shown).not.toContain(PAYLOAD);
    expect(shown.split('/import-note/')[1]).toBe('…');
  });

  test('the payload prefix it used to show is identical across DIFFERENT receipts', () => {
    // The reason no characters are shown. Different note, owner and chain, same
    // leading bytes - so a prefix could never have identified anything.
    const a = encode(receipt(1, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1));
    const b = encode(receipt(999, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 56));
    expect(a).not.toBe(b);
    expect(a.slice(0, 8)).toBe(b.slice(0, 8));
    expect(Buffer.from(a.slice(0, 8), 'base64url').toString()).toBe('{"note');
  });

  test('a later marker in a fragment cannot preserve the real payload', () => {
    const hostile = `${URL}#/import-note/x`;
    expect(previewNoteReceiptUrl(hostile)).not.toContain(PAYLOAD);
    expect(previewNoteReceiptUrl(hostile)).toBe('https://privacypools.com/import-note/…');
  });

  test('handles the native relative-path form', () => {
    expect(previewNoteReceiptUrl(`/import-note/${PAYLOAD}`)).toBe('/import-note/…');
  });

  test('fails CLOSED on anything it does not recognise', () => {
    // Notably a BARE receipt code, which the importer accepts and which an
    // earlier version echoed back in full.
    expect(previewNoteReceiptUrl(PAYLOAD)).toBe('…');
    expect(previewNoteReceiptUrl('https://privacypools.com/')).toBe('…');
    expect(previewNoteReceiptUrl('')).toBe('…');
  });

  test('the preview cannot be decoded back into a receipt', () => {
    // The most direct statement of the point: run the preview through the same
    // extraction the importer uses and there is nothing usable left.
    const shown = previewNoteReceiptUrl(URL);
    const tail = shown.split('/import-note/')[1] ?? '';
    const candidate = tail.split(/[?#/\s]/)[0];
    expect(candidate).toBe('…');
    expect(() => JSON.parse(Buffer.from(candidate, 'base64url').toString())).toThrow();
  });
});
