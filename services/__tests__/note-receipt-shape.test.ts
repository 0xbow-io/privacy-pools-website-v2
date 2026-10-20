import { describe, expect, test } from 'bun:test';

import {
  importableNoteShape,
  isRecoveredClaimNote,
  linkImportRefusal,
  recoveredClaimReceiptPayload,
  unanchoredLinkNotes,
} from '../note-receipt-shape';

/**
 * A claim link is attacker-controllable input. These rules decide which notes
 * the import and render paths are allowed to dereference. Two shapes exist;
 * anything else must be refused as a whole link, not thrown from render.
 */

const H32 = (b: string) => `0x${b.repeat(32)}`;
const H20 = (b: string) => `0x${b.repeat(20)}`;

const full = () => ({
  commitment: H32('aa'),
  value: '0xb5e620f48000',
  tokenId: H20('ee'),
  ownerAddress: H20('42'),
});

const recovered = () => ({
  noteSecret: H32('11'),
  label: H32('22'),
  value: '0xb5e620f48000',
  tokenId: H20('ee'),
});

describe('which shape a note is', () => {
  test('a send-time receipt note is FULL', () => {
    expect(importableNoteShape(full())).toBe('full');
    expect(isRecoveredClaimNote(full())).toBe(false);
  });

  test('a note with no owner and no commitment but a secret and label is RECOVERED', () => {
    expect(importableNoteShape(recovered())).toBe('recovered');
    expect(isRecoveredClaimNote(recovered())).toBe(true);
  });

  test('a full note is not mistaken for recovered just because it also carries a secret', () => {
    // Send-time receipts DO carry noteSecret + label; the discriminator is the
    // ABSENCE of owner and commitment, not the presence of the secret.
    const n = { ...full(), noteSecret: H32('11'), label: H32('22') };
    expect(importableNoteShape(n)).toBe('full');
    expect(isRecoveredClaimNote(n)).toBe(false);
  });

  test('half a shape is neither: missing fields refuse the note', () => {
    // Recovered without a label, or full without a commitment, or a recovered
    // note that smuggles in only one of owner/commitment.
    expect(importableNoteShape({ noteSecret: H32('11'), value: '0x1', tokenId: H20('ee') })).toBeNull();
    expect(importableNoteShape({ value: '0x1', tokenId: H20('ee'), ownerAddress: H20('42') })).toBeNull();
    expect(importableNoteShape({ ...recovered(), ownerAddress: H20('42') })).toBeNull();
    expect(importableNoteShape({ ...recovered(), commitment: H32('aa') })).toBeNull();
  });

  test('every dereferenced field must be hex, for both shapes', () => {
    for (const field of ['commitment', 'value', 'tokenId', 'ownerAddress'] as const) {
      expect({ field, shape: importableNoteShape({ ...full(), [field]: 'not-hex' }) }).toEqual({ field, shape: null });
      expect({ field, shape: importableNoteShape({ ...full(), [field]: 42 }) }).toEqual({ field, shape: null });
    }
    for (const field of ['noteSecret', 'label', 'value', 'tokenId'] as const) {
      expect({ field, shape: importableNoteShape({ ...recovered(), [field]: 'not-hex' }) }).toEqual({ field, shape: null });
    }
  });

  test('value must parse as a BigInt, since render does BigInt(note.value)', () => {
    expect(importableNoteShape({ ...full(), value: '0x' })).toBeNull();
    expect(importableNoteShape({ ...recovered(), value: '0x' })).toBeNull();
    expect(importableNoteShape({ ...recovered(), value: '0x1' })).toBe('recovered');
  });

  test('value is a positive canonical field element: v + r would hash to the same commitment as v', () => {
    const r = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    const v = BigInt('0xb5e620f48000');
    // Poseidon reduces mod r, so an amount inflated by r reproduces the real
    // commitment and would import a note with a forged displayed amount.
    for (const shape of [full, recovered]) {
      expect(importableNoteShape({ ...shape(), value: `0x${(v + r).toString(16)}` })).toBeNull();
      expect(importableNoteShape({ ...shape(), value: `0x${r.toString(16)}` })).toBeNull();
      expect(importableNoteShape({ ...shape(), value: `0x${(r - 1n).toString(16)}` })).not.toBeNull();
      // A zero note is not a claim.
      expect(importableNoteShape({ ...shape(), value: '0x0' })).toBeNull();
      expect(importableNoteShape({ ...shape(), value: '0x00' })).toBeNull();
    }
  });

  test('hashes and secrets are exactly 32 bytes, addresses exactly 20, as the SDK pads them', () => {
    expect(importableNoteShape({ ...full(), commitment: '0xaa' })).toBeNull();
    expect(importableNoteShape({ ...full(), ownerAddress: '0x42' })).toBeNull();
    expect(importableNoteShape({ ...full(), tokenId: `0x${'ee'.repeat(32)}` })).toBeNull();
    expect(importableNoteShape({ ...recovered(), noteSecret: '0x11' })).toBeNull();
    expect(importableNoteShape({ ...recovered(), label: `0x${'22'.repeat(33)}` })).toBeNull();
    expect(importableNoteShape({ ...recovered(), tokenId: '0xee' })).toBeNull();
  });

  test('non-objects are refused without throwing', () => {
    for (const bad of [null, undefined, 'str', 7, [], true]) {
      expect(importableNoteShape(bad)).toBeNull();
    }
  });
});

describe('the recovered-claim receipt payload', () => {
  const claim = (over: Partial<Parameters<typeof recoveredClaimReceiptPayload>[0][number]> = {}) => ({
    chainId: 11155111,
    txHash: '0xdead',
    noteSecret: H32('11'),
    value: '0xb5e620f48000',
    tokenId: H20('ee'),
    label: H32('22'),
    ...over,
  });

  test('carries the four SDK fields and NOTHING that names the recipient', () => {
    const p = recoveredClaimReceiptPayload([claim()], 'ACTIVE')!;
    expect(p.notes).toHaveLength(1);
    const n = p.notes[0];
    expect(n.noteSecret).toBe(H32('11'));
    expect(n.value).toBe('0xb5e620f48000');
    expect(n.tokenId).toBe(H20('ee'));
    expect(n.label).toBe(H32('22'));
    expect(n.txHash).toBe('0xdead');
    expect(n.status).toBe('ACTIVE');
    expect(n.isOwned).toBe(true);
    // Absent by design: the import path fills these from the claimant's session.
    expect('ownerAddress' in n).toBe(false);
    expect('commitment' in n).toBe(false);
    // And the note it produces is the RECOVERED shape the importer accepts.
    expect(importableNoteShape(n)).toBe('recovered');
  });

  test('the EXACT key set, so no future field (a key, an address) can slip into a link unnoticed', () => {
    // A link is shared out of band and lives in chat histories. It may carry
    // the note's own randomness and nothing that identifies or empowers
    // anyone: no address, no commitment, no viewing or spending key material
    // (Pat, 2026-09-16, after an earlier link leaked the recipient address).
    const p = recoveredClaimReceiptPayload([claim()], 'ACTIVE')!;
    expect(Object.keys(p).sort()).toEqual(['chainId', 'notes', 'syncCursor']);
    expect(Object.keys(p.notes[0]).sort()).toEqual([
      'createdAtBlock', 'isOwned', 'label', 'noteSecret', 'spentAtBlock', 'status', 'tokenId', 'txHash', 'value',
    ]);
  });

  test('createdAtBlock is the 0x0 stub the importer heals after materialisation', () => {
    expect(recoveredClaimReceiptPayload([claim()], 'ACTIVE')!.notes[0].createdAtBlock).toBe('0x0');
  });

  test('the envelope names the chain from the first claim', () => {
    const p = recoveredClaimReceiptPayload([claim(), claim({ txHash: '0xbeef' })], 'ACTIVE')!;
    expect(p.chainId).toBe(11155111);
    expect(p.syncCursor).toBe('0x0');
    expect(p.notes.map((n) => n.txHash)).toEqual(['0xdead', '0xbeef']);
  });

  test('no claims, no payload', () => {
    expect(recoveredClaimReceiptPayload([], 'ACTIVE')).toBeNull();
  });
});

describe('a link note must be on-chain before it is imported (audit F-01)', () => {
  const anchored = { commitment: '0xaa', createdAtBlock: '0x1234' };
  const stub = { commitment: '0xbb', createdAtBlock: '0x0' };
  const missing = { commitment: '0xcc' };

  test('a stub or missing block is unanchored; a real one is not', () => {
    expect(unanchoredLinkNotes([anchored, stub, missing]).map((n) => n.commitment)).toEqual(['0xbb', '0xcc']);
    expect(unanchoredLinkNotes([anchored])).toEqual([]);
    // Garbage in the field is not evidence of anything.
    expect(unanchoredLinkNotes([{ commitment: '0xdd', createdAtBlock: 'later' }])).toHaveLength(1);
    expect(unanchoredLinkNotes([{ commitment: '0xee', createdAtBlock: '' }])).toHaveLength(1);
  });

  test('nothing unanchored means nothing to say', () => {
    expect(linkImportRefusal([], true)).toBeNull();
    expect(linkImportRefusal([], false)).toBeNull();
  });

  test('an incomplete lookup says so rather than asserting the chain is empty', () => {
    // A crafted link and an ASP hiccup look identical from here, so the honest
    // message is "could not verify", and nothing is imported either way.
    expect(linkImportRefusal([stub], false)).toBe('Could not verify this claim on-chain yet. Nothing was imported. Retry in a moment.');
    expect(linkImportRefusal([{ ...stub, recovered: true }], false)).toContain('Could not verify');
  });

  test('a complete lookup names the real problem, and a recovered claim keeps its own wording', () => {
    expect(linkImportRefusal([stub], true)).toBe('This claim is not on-chain, so there is nothing to import. Nothing was imported.');
    expect(linkImportRefusal([{ ...stub, recovered: true }], true)).toContain('Sign in as the recipient');
    // Every refusal ends the same way: the device is untouched.
    for (const refusal of [linkImportRefusal([stub], true), linkImportRefusal([stub], false), linkImportRefusal([{ ...stub, recovered: true }], true)]) {
      expect(refusal).toContain('Nothing was imported.');
      expect(refusal).not.toMatch(/—/);
    }
  });
});
