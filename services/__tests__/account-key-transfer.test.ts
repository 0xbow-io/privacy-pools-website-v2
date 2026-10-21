import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDecipheriv } from 'node:crypto';
import { argon2idAsync } from '@noble/hashes/argon2.js';
import {
  KDF_FAILED_MESSAGE,
  TRANSFER_CODE_ALPHABET,
  TRANSFER_KDF,
  TRANSFER_PAYLOAD_PREFIX,
  base64UrlToBytes,
  bytesToBase64Url,
  formatTransferCode,
  generateTransferCode,
  normalizeTransferCode,
  openAccountKeyTransfer,
  sealAccountKeyForTransfer,
  transferCodeCheckChar,
} from '@/services/account-key-transfer';
import { transferKdf as webKdf } from '@/services/account-key-transfer-kdf';
import { makeExpoArgon2Kdf, type ExpoArgon2Like } from '@/services/account-key-transfer-kdf-expo';
import { encodeAccountKey } from '@/services/account-key';

// fileURLToPath, not URL.pathname: the latter stays percent-encoded (spaces,
// non-ASCII) and keeps a leading slash before a Windows drive letter.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------------------------------------------------------------------------
// Shared vector. The expected key and payload were produced OUTSIDE this
// codebase by the reference C Argon2 (phc-winner-argon2 as bundled in
// argon2-cffi 23.1.0, v0x13) and OpenSSL AES-256-GCM (cryptography 43.0.3):
//
//   hash_secret_raw(b"7KQ4M9X2PY", bytes(range(1, 17)), time_cost=3,
//     memory_cost=65536, parallelism=1, hash_len=32, type=Type.ID)
//   AESGCM(key).encrypt(bytes(0xA0+i for i in range(12)), PLAINTEXT,
//     b"ppv2-ak1:" + b"\x01")
//
// PLAINTEXT is the 36-byte ASCII string below, sealed as-is (an
// account-key-shaped base64 string, like the real encoded key). It is NOT the
// 27-byte JSON it happens to decode to. 36 + 16 tag = 52 bytes ciphertext,
// 1 + 16 + 12 + 52 = 81-byte body, 117-char payload; asserted below.
//
// argon2kt (Android) and Argon2Swift (iOS), which expo-argon2 wraps, are
// that same C reference, so matching it here is what "byte-identical on web
// and phone" means. Both paths below are checked against this one VECTOR.
// ---------------------------------------------------------------------------
const VECTOR = {
  code: '7KQ4M9X2PY',
  typed: '7kq4-m9x2-py',
  salt: Uint8Array.from({ length: 16 }, (_, i) => i + 1),
  nonce: Uint8Array.from({ length: 12 }, (_, i) => 0xa0 + i),
  plaintext: 'eyJraW5kIjoicHB2Mi1hY2NvdW50LWtleSJ9',
  key: '9a1de758dcb122ae0a072ce0a99302799ffe7158375d6dd3bbfbed9e1d506846',
  payload: 'ppv2-ak1:AQECAwQFBgcICQoLDA0ODxCgoaKjpKWmp6ipqqu1SV-0kfTS81-qWgS-d6Foyv4nPID-XeC3qxILxgLoOwxEChoqyLtrJe5_Ro2PFnwmigho',
};

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const ascii = (s: string) => new TextEncoder().encode(s);

/**
 * Stands in for the expo-argon2 native module. It receives exactly what the
 * phone passes across the bridge and answers like the native side does
 * (lowercase hex), computing with @noble/hashes, an Argon2id independent of
 * hash-wasm. Only the option names it understands are honoured, so a renamed
 * or dropped option changes the output and fails the vector.
 */
function fakeExpoArgon2(calls: unknown[]): ExpoArgon2Like {
  return {
    hashAsync: async (password, salt, options) => {
      calls.push({ password: Array.from(password), salt: Array.from(salt), options });
      if (options.type !== 'argon2id') throw new Error('not argon2id');
      const out = await argon2idAsync(password, salt, {
        t: options.timeCost, m: options.memoryCost, p: options.parallelism, dkLen: options.hashLength,
      });
      return { hex: hex(out) };
    },
  };
}

describe('transfer code', () => {
  test('vector code carries a valid check symbol', () => {
    expect(transferCodeCheckChar(VECTOR.code.slice(0, 9))).toBe(VECTOR.code[9]);
    expect(normalizeTransferCode(VECTOR.code)).toBe(VECTOR.code);
  });

  test('alphabet has no lookalikes', () => {
    for (const ch of '01OILU') expect(TRANSFER_CODE_ALPHABET.includes(ch)).toBe(false);
    expect(new Set(TRANSFER_CODE_ALPHABET).size).toBe(TRANSFER_CODE_ALPHABET.length);
  });

  test('generated codes are 10 symbols, valid, and format as XXXX-XXXX-XX', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const code = generateTransferCode();
      expect(code).toMatch(new RegExp(`^[${TRANSFER_CODE_ALPHABET}]{10}$`));
      expect(normalizeTransferCode(code)).toBe(code);
      expect(formatTransferCode(code)).toMatch(/^.{4}-.{4}-.{2}$/);
      seen.add(code);
    }
    expect(seen.size).toBe(500);
  });

  test('rejection sampling never uses bytes >= 240', () => {
    let calls = 0;
    // First fill is all 255 (rejected), then a counting pattern.
    const fill = (b: Uint8Array) => {
      for (let i = 0; i < b.length; i++) b[i] = calls === 0 ? 255 : (i * 31 + 3) % 240;
      calls++;
      return b;
    };
    const code = generateTransferCode(fill);
    expect(calls).toBe(2);
    expect(code.slice(0, 9)).toBe(Array.from({ length: 9 }, (_, i) => TRANSFER_CODE_ALPHABET[((i * 31 + 3) % 240) % 30]).join(''));
  });

  test('input is case-insensitive and dashes/spaces are optional', () => {
    expect(normalizeTransferCode(VECTOR.typed)).toBe(VECTOR.code);
    expect(normalizeTransferCode(' 7KQ4 M9X2 PY ')).toBe(VECTOR.code);
    expect(normalizeTransferCode(formatTransferCode(VECTOR.code))).toBe(VECTOR.code);
  });

  test('every single-symbol typo is rejected', () => {
    for (let i = 0; i < VECTOR.code.length; i++) {
      for (const ch of TRANSFER_CODE_ALPHABET) {
        if (ch === VECTOR.code[i]) continue;
        const typo = VECTOR.code.slice(0, i) + ch + VECTOR.code.slice(i + 1);
        expect(normalizeTransferCode(typo)).toBeNull();
      }
    }
  });

  test('wrong length, lookalikes and made-up codes are rejected', () => {
    expect(normalizeTransferCode('')).toBeNull();
    expect(normalizeTransferCode(VECTOR.code.slice(0, 9))).toBeNull();
    expect(normalizeTransferCode(VECTOR.code + '2')).toBeNull();
    expect(normalizeTransferCode('7KQ4M9X2P0')).toBeNull();
    expect(normalizeTransferCode('OKQ4M9X2PY')).toBeNull();
    expect(normalizeTransferCode('AAAA-AAAA-AB')).toBeNull();
  });
});

describe('payload codec', () => {
  test('base64url round-trips every length', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 97 + n) & 255);
      const text = bytesToBase64Url(bytes);
      expect(text).toBe(Buffer.from(bytes).toString('base64url'));
      expect(Array.from(base64UrlToBytes(text)!)).toEqual(Array.from(bytes));
    }
    expect(base64UrlToBytes('a+b/')).toBeNull();
  });
});

describe('shared vector: web and phone derive and encrypt byte-identically', () => {
  test('the vector is self-consistent: OpenSSL opens the payload with the reference key', () => {
    expect(ascii(VECTOR.plaintext).length).toBe(36);
    const body = base64UrlToBytes(VECTOR.payload.slice(TRANSFER_PAYLOAD_PREFIX.length))!;
    expect(VECTOR.payload.length).toBe(117);
    expect(body.length).toBe(1 + 16 + 12 + 36 + 16);
    expect(body[0]).toBe(1);
    expect(Array.from(body.slice(1, 17))).toEqual(Array.from(VECTOR.salt));
    expect(Array.from(body.slice(17, 29))).toEqual(Array.from(VECTOR.nonce));
    // node:crypto is OpenSSL, independent of @noble/ciphers used by the app.
    const ct = body.slice(29, body.length - 16);
    const tag = body.slice(body.length - 16);
    const d = createDecipheriv('aes-256-gcm', Buffer.from(VECTOR.key, 'hex'), VECTOR.nonce);
    d.setAAD(Buffer.concat([Buffer.from(TRANSFER_PAYLOAD_PREFIX, 'ascii'), Buffer.from([1])]));
    d.setAuthTag(tag);
    expect(Buffer.concat([d.update(ct), d.final()]).toString('utf8')).toBe(VECTOR.plaintext);
  });

  test('web Argon2id (hash-wasm) matches the C reference', async () => {
    expect(hex(await webKdf(ascii(VECTOR.code), VECTOR.salt))).toBe(VECTOR.key);
  });

  test('phone glue (expo-argon2 call shape) matches the C reference', async () => {
    const calls: unknown[] = [];
    const phoneKdf = makeExpoArgon2Kdf(fakeExpoArgon2(calls));
    expect(hex(await phoneKdf(ascii(VECTOR.code), VECTOR.salt))).toBe(VECTOR.key);
    expect(calls).toEqual([{
      password: Array.from(ascii(VECTOR.code)),
      salt: Array.from(VECTOR.salt),
      options: { timeCost: 3, memoryCost: 65536, parallelism: 1, hashLength: 32, type: 'argon2id' },
    }]);
  }, 60_000);

  test('frozen KDF parameters', () => {
    expect(TRANSFER_KDF).toEqual({ type: 'argon2id', memoryKiB: 65536, passes: 3, parallelism: 1, hashLength: 32 });
  });

  test('web seal with the vector salt+nonce reproduces the reference payload', async () => {
    const payload = await sealAccountKeyForTransfer({
      code: VECTOR.typed, plaintext: VECTOR.plaintext, kdf: webKdf, salt: VECTOR.salt, nonce: VECTOR.nonce,
    });
    expect(payload).toBe(VECTOR.payload);
  });

  test('phone opens the reference payload with the code it holds', async () => {
    const phoneKdf = makeExpoArgon2Kdf(fakeExpoArgon2([]));
    expect(await openAccountKeyTransfer({ code: VECTOR.code, payload: VECTOR.payload, kdf: phoneKdf })).toBe(VECTOR.plaintext);
  }, 60_000);

  test('phone seal with the vector salt+nonce reproduces the same payload', async () => {
    const phoneKdf = makeExpoArgon2Kdf(fakeExpoArgon2([]));
    expect(await sealAccountKeyForTransfer({
      code: VECTOR.code, plaintext: VECTOR.plaintext, kdf: phoneKdf, salt: VECTOR.salt, nonce: VECTOR.nonce,
    })).toBe(VECTOR.payload);
  }, 60_000);
});

describe('seal / open', () => {
  const accountKey = encodeAccountKey({
    address: `0x${'ab'.repeat(20)}`,
    signature: `0x${'cd'.repeat(65)}`,
    legacySignature: `0x${'ef'.repeat(65)}`,
  });

  test('round trip with fresh salt and nonce, and every export differs', async () => {
    const code = generateTransferCode();
    const a = await sealAccountKeyForTransfer({ code, plaintext: accountKey, kdf: webKdf });
    const b = await sealAccountKeyForTransfer({ code, plaintext: accountKey, kdf: webKdf });
    expect(a.startsWith(TRANSFER_PAYLOAD_PREFIX)).toBe(true);
    expect(a).not.toBe(b);
    expect(await openAccountKeyTransfer({ code: code.toLowerCase(), payload: a, kdf: webKdf })).toBe(accountKey);
    // A full key with a legacy signature still fits a scannable QR.
    expect(a.length).toBeLessThan(900);
  });

  test('wrong code fails', async () => {
    const payload = VECTOR.payload;
    let other = generateTransferCode();
    while (other === VECTOR.code) other = generateTransferCode();
    await expect(openAccountKeyTransfer({ code: other, payload, kdf: webKdf })).rejects.toThrow('Wrong code');
  });

  test('tampered ciphertext, salt or version fails', async () => {
    const body = base64UrlToBytes(VECTOR.payload.slice(TRANSFER_PAYLOAD_PREFIX.length))!;
    for (const at of [body.length - 1, 1, 20]) {
      const t = body.slice();
      t[at] ^= 1;
      await expect(openAccountKeyTransfer({
        code: VECTOR.code, payload: TRANSFER_PAYLOAD_PREFIX + bytesToBase64Url(t), kdf: webKdf,
      })).rejects.toThrow();
    }
    const v = body.slice();
    v[0] = 2;
    await expect(openAccountKeyTransfer({
      code: VECTOR.code, payload: TRANSFER_PAYLOAD_PREFIX + bytesToBase64Url(v), kdf: webKdf,
    })).rejects.toThrow('Update the app');
  });

  test('invalid code is refused before any derivation', async () => {
    let derived = 0;
    const kdf = async () => { derived++; return new Uint8Array(32); };
    await expect(sealAccountKeyForTransfer({ code: 'AAAA-AAAA-AB', plaintext: 'x', kdf })).rejects.toThrow('not valid');
    await expect(openAccountKeyTransfer({ code: 'nope', payload: VECTOR.payload, kdf })).rejects.toThrow('not valid');
    expect(derived).toBe(0);
  });

  test('a non-transfer QR is refused', async () => {
    await expect(openAccountKeyTransfer({ code: VECTOR.code, payload: 'wc:abc@2', kdf: webKdf })).rejects.toThrow('Not a Privacy Pools');
  });

  test('a KDF that throws or returns the wrong size gives one short message', async () => {
    const throwing = async (): Promise<Uint8Array> => { throw new Error('RangeError: WebAssembly.Memory(): could not allocate memory'); };
    const short = async () => new Uint8Array(16);
    const broken = makeExpoArgon2Kdf({ hashAsync: async () => { throw new Error('E_ARGON2 native boom'); } });
    for (const kdf of [throwing, short, broken]) {
      await expect(openAccountKeyTransfer({ code: VECTOR.code, payload: VECTOR.payload, kdf })).rejects.toThrow(KDF_FAILED_MESSAGE);
      await expect(sealAccountKeyForTransfer({ code: VECTOR.code, plaintext: 'x', kdf })).rejects.toThrow(KDF_FAILED_MESSAGE);
    }
  });
});

describe('no network, no persistence', () => {
  const files = [
    'services/account-key-transfer.ts',
    'services/account-key-transfer-kdf.ts',
    'services/account-key-transfer-kdf-expo.ts',
    'services/account-key-transfer-kdf.native.ts',
    'services/mobile-account-key-store.ts',
    'components/account-key-to-mobile-modal.tsx',
    'components/mobile-account-keys-provider.tsx',
    'components/mobile-account-keys-provider.native.tsx',
  ];
  const NETWORK = /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|egress|errorReport|Sentry|axios|@\/services\/(rpc|relayer|asp|api)/;

  for (const file of files) {
    test(`${file} makes no request`, () => {
      const src = readFileSync(join(ROOT, file), 'utf8');
      expect(src).not.toMatch(NETWORK);
      // Logging could carry the code or key into a console capture.
      expect(src).not.toMatch(/console\.(log|info|warn|error|debug)/);
    });
  }

  test('the web export modal never writes browser storage', () => {
    const src = readFileSync(join(ROOT, 'components/account-key-to-mobile-modal.tsx'), 'utf8');
    expect(src).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|clipboard/i);
  });
});
