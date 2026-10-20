// The only thing this feature persists: the passkey EOA's PUBLIC address and
// the credential id (public, it lets the next prompt go straight to that
// passkey). No key, no PRF, nothing derived from them besides the address.
// Storage is injected so the bun suite can drive it; the app passes SecureStore.

import { getAddress, type Address } from 'viem';

export type PublicKV = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

export type PasskeyEoaRecord = { address: Address; credentialId: string | null };

export const PASSKEY_EOA_RECORD_KEY = 'ppv2_passkey_eoa_v1';

export async function loadPasskeyEoaRecord(kv: PublicKV): Promise<PasskeyEoaRecord | null> {
  const raw = await kv.get(PASSKEY_EOA_RECORD_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { address?: unknown; credentialId?: unknown };
    if (typeof parsed.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(parsed.address)) return null;
    const credentialId = typeof parsed.credentialId === 'string' && /^[A-Za-z0-9_-]+$/.test(parsed.credentialId)
      ? parsed.credentialId
      : null;
    return { address: getAddress(parsed.address), credentialId };
  } catch {
    return null;
  }
}

export async function savePasskeyEoaRecord(kv: PublicKV, record: PasskeyEoaRecord): Promise<void> {
  await kv.set(PASSKEY_EOA_RECORD_KEY, JSON.stringify({ address: record.address, credentialId: record.credentialId }));
}

export async function clearPasskeyEoaRecord(kv: PublicKV): Promise<void> {
  await kv.remove(PASSKEY_EOA_RECORD_KEY);
}
