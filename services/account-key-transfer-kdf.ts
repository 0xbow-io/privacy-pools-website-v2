import { argon2id } from 'hash-wasm';
import { TRANSFER_KDF, type TransferKdf } from '@/services/account-key-transfer';

/**
 * Web Argon2id (WASM embedded in the bundle, nothing is fetched). The phone
 * build resolves account-key-transfer-kdf.native.ts instead, because Hermes
 * has no WebAssembly.
 */
export const transferKdf: TransferKdf = (password, salt) => argon2id({
  password,
  salt,
  iterations: TRANSFER_KDF.passes,
  parallelism: TRANSFER_KDF.parallelism,
  memorySize: TRANSFER_KDF.memoryKiB,
  hashLength: TRANSFER_KDF.hashLength,
  outputType: 'binary',
});
