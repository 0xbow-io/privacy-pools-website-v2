// @ts-nocheck
// ONE-OFF probe: which key scheme does account B's on-chain viewing key match?
// Derives both schemes offline (legacy keccak + new HKDF SecretDerivation) from
// B's private key and compares to Keystore.viewingKeys(B). No react-native.
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, keccak256, toBytes, toHex, bytesToHex } from 'viem';
import { sepolia } from 'viem/chains';
import { x25519 } from '@noble/curves/ed25519.js';
import { APP_IDENTIFIER, CryptoService, KeystoreManager } from '@privacy-pools-v2/sdk';
import { envValue } from './funding';

const raw = envValue('E2E_ACCOUNT_B_PK') ?? envValue('DEV_PK2');
const key = raw.startsWith('0x') ? raw : `0x${raw}`;
const B = privateKeyToAccount(key);
console.log('B', B.address);

// Legacy keccak scheme (services/sdk-setup.ts deriveLegacyKeccakKeystoreManager).
const legacySig = await B.signTypedData({
  domain: { name: 'Privacy Pools', version: '1' },
  types: { DeriveSeed: [{ name: 'action', type: 'string' }, { name: 'context', type: 'string' }, { name: 'addressHash', type: 'bytes32' }] },
  primaryType: 'DeriveSeed',
  message: { action: 'Derive Account Seed', context: 'privacy-pools/wallet-seed:v2', addressHash: keccak256(toBytes(B.address)) },
});
const sHex = legacySig.slice(2).slice(64, 128);
const legacyPriv = keccak256(toBytes(('0x03' + sHex) as `0x${string}`));
const legacyView = bytesToHex(x25519.getPublicKey(toBytes(legacyPriv))).toLowerCase();

// New HKDF scheme (SDK KeystoreManager.fromSignature over the SecretDerivation payload).
const addressHash = keccak256(toBytes(B.address));
const newSig = await B.signTypedData({
  domain: { name: 'Standardized Secret Derivation', version: '1', verifyingContract: '0x0000000000000000000000000000000000000000', salt: keccak256(toHex(APP_IDENTIFIER)) },
  types: { SecretDerivation: [{ name: 'purpose', type: 'string' }, { name: 'addressHash', type: 'bytes32' }] },
  primaryType: 'SecretDerivation',
  message: { purpose: 'This signature is used to deterministically derive application-specific secrets from your master seed. It is not a transaction and will not cost any gas.', addressHash },
});
const newKm = KeystoreManager.fromSignature({ signature: newSig, signerAddress: B.address, addressHash, revocableKeyIndex: '0x0' }, { cryptoService: new CryptoService() });
const newView = newKm.getViewingKeyPair().publicKey.toLowerCase();

const client = createPublicClient({ chain: sepolia, transport: http('https://ethereum-sepolia-rpc.publicnode.com') });
const abi = [{ name: 'viewingKeys', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'bytes32' }] }];
const onView = String(await client.readContract({ address: '0x6d264acb9c3a7a3105c29470afe2f5f1ec203c73', abi, functionName: 'viewingKeys', args: [B.address] })).toLowerCase();
console.log('on-chain viewingKeys(B):', onView);
console.log('legacy keccak view pub :', legacyView, legacyView === onView ? '<== MATCH' : '');
console.log('new HKDF view pub      :', newView, newView === onView ? '<== MATCH' : '');
