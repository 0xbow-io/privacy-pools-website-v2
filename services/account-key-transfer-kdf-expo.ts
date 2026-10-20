import { TRANSFER_KDF, type TransferKdf } from '@/services/account-key-transfer';

/** The slice of expo-argon2 this uses (argon2kt on Android, Argon2Swift on iOS). */
export type ExpoArgon2Like = {
  hashAsync: (
    password: Uint8Array,
    salt: Uint8Array,
    options: { timeCost: number; memoryCost: number; parallelism: number; hashLength: number; type: 'argon2id' },
  ) => Promise<{ hex: string }>;
};

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) throw new Error('Key derivation failed.');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Phone Argon2id. Kept apart from the .native entry so the bun test drives
 * exactly this glue (bytes in, option names, hex out) against a reference
 * Argon2id and proves it matches the web path.
 */
export function makeExpoArgon2Kdf(mod: ExpoArgon2Like): TransferKdf {
  return async (password, salt) => {
    const result = await mod.hashAsync(password, salt, {
      timeCost: TRANSFER_KDF.passes,
      memoryCost: TRANSFER_KDF.memoryKiB,
      parallelism: TRANSFER_KDF.parallelism,
      hashLength: TRANSFER_KDF.hashLength,
      type: TRANSFER_KDF.type,
    });
    const key = hexToBytes(result.hex);
    if (key.length !== TRANSFER_KDF.hashLength) throw new Error('Key derivation failed.');
    return key;
  };
}
