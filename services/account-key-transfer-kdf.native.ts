import { hashAsync } from 'expo-argon2';
import type { TransferKdf } from '@/services/account-key-transfer';
import { makeExpoArgon2Kdf } from '@/services/account-key-transfer-kdf-expo';

/** Phone Argon2id: native code, since Hermes has no WebAssembly. */
export const transferKdf: TransferKdf = makeExpoArgon2Kdf({ hashAsync });
