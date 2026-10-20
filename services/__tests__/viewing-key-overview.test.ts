import { describe, expect, test } from 'bun:test';
import {
  buildViewingKeyOverview,
  resolveViewingKeyStatus,
  shortHex,
  VIEWING_KEY_FACTS,
  VIEWING_KEY_STATUS_COPY,
} from '../viewing-key-overview';

const PUB = '0x2d9de57892a552be499b77f38b129a61f500219969b0e67d7fd38373a778f208';
const OTHER = '0x4dc29e6658ed4f6c438f378eeaaf0bc326e73fd91978b65da2c3b2c07032c860';
const ZERO = `0x${'0'.repeat(64)}`;

describe('resolveViewingKeyStatus', () => {
  test('published when the derived key equals the on-chain key (case-insensitive)', () => {
    expect(resolveViewingKeyStatus(PUB, PUB.toUpperCase().replace('0X', '0x'))).toBe('published');
  });
  test('unpublished on the zero key; mismatch on a different key', () => {
    expect(resolveViewingKeyStatus(PUB, ZERO)).toBe('unpublished');
    expect(resolveViewingKeyStatus(PUB, '0x0')).toBe('unpublished');
    expect(resolveViewingKeyStatus(PUB, OTHER)).toBe('mismatch');
  });
  test('unknown without a session key or without an on-chain read', () => {
    expect(resolveViewingKeyStatus(null, PUB)).toBe('unknown');
    expect(resolveViewingKeyStatus(PUB, null)).toBe('unknown');
    expect(resolveViewingKeyStatus(PUB, undefined)).toBe('unknown');
  });
});

describe('buildViewingKeyOverview', () => {
  test('lowercases the key, shortens it, and carries the status copy', () => {
    const o = buildViewingKeyOverview(PUB.toUpperCase().replace('0X', '0x'), PUB);
    expect(o.publicKey).toBe(PUB);
    expect(o.shortKey).toBe(shortHex(PUB));
    expect(o.status).toBe('published');
    expect(o.statusText).toBe(VIEWING_KEY_STATUS_COPY.published);
  });
  test('no key yet: unknown with null key fields', () => {
    expect(buildViewingKeyOverview(null, null)).toEqual({ status: 'unknown', publicKey: null, shortKey: null, statusText: VIEWING_KEY_STATUS_COPY.unknown });
  });
});

describe('copy discipline', () => {
  test('the facts say static, whole-history/forward-only, and private key stays local; never promise rotation or revocation', () => {
    const all = VIEWING_KEY_FACTS.join(' ');
    expect(all).toMatch(/cannot rotate it today/i);
    expect(all).toMatch(/past and future/i);
    expect(all).toMatch(/cannot be undone/i);
    expect(all).toMatch(/shows only the public key/i);
    expect(all).toMatch(/account key or passkey backup can recreate/i);
    expect(all).not.toMatch(/rotate now|revoke|revocable/i);
    // No em dashes in user-facing copy (house rule).
    for (const s of [...VIEWING_KEY_FACTS, ...Object.values(VIEWING_KEY_STATUS_COPY)]) expect(s).not.toContain('—');
  });
  test('shortHex keeps head and tail', () => {
    expect(shortHex(PUB)).toBe('0x2d9de578…78f208');
    expect(shortHex('0x1234')).toBe('0x1234');
  });
});
