/**
 * Stellar StrKey checks (base32, version byte, CRC16-XModem), so a typo or a
 * tampered character is refused in the app rather than later by the SDK.
 *
 * Pure module (no SDK, no react-native) so the payment-request codec and the
 * forms can use it on the page-load path and in bun tests.
 */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ED25519_PUBLIC_KEY_VERSION = 6 << 3; // G...
const CONTRACT_VERSION = 2 << 3; // C...

function crc16xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function isStrKey(value: string | null | undefined, prefix: 'G' | 'C', version: number): boolean {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}[A-Z2-7]{55}$`).test(value)) return false;
  // 56 base32 chars = 280 bits = 35 bytes: version, 32-byte key, CRC16 (LE).
  const bytes = new Uint8Array(35);
  let bits = 0;
  let acc = 0;
  let n = 0;
  for (const ch of value) {
    acc = ((acc << 5) | BASE32.indexOf(ch)) & 0xfffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes[n++] = (acc >> bits) & 0xff;
    }
  }
  if (n !== 35 || bytes[0] !== version) return false;
  const crc = crc16xmodem(bytes.subarray(0, 33));
  return bytes[33] === (crc & 0xff) && bytes[34] === (crc >> 8);
}

/** A Stellar account address (G..., ed25519 public key) with a valid checksum. */
export function isStellarAccountAddress(value: string | null | undefined): boolean {
  return isStrKey(value, 'G', ED25519_PUBLIC_KEY_VERSION);
}

/** A Soroban contract address (C..., e.g. an asset contract) with a valid checksum. */
export function isStellarContractAddress(value: string | null | undefined): boolean {
  return isStrKey(value, 'C', CONTRACT_VERSION);
}
