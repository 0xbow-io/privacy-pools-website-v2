// @ts-nocheck
// ONE-OFF probe: can B's derived key decrypt the depositFor Note events that
// the ASP snapshot carries? Splits "encryption side wrong" from "the app's
// discovery pipeline never scanned them".
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toBytes, toHex } from 'viem';
import { APP_IDENTIFIER, CryptoService, KeystoreManager, NoteComputationService, EvmAddressFieldConverter, EvmNoteDiscoveryService, PoseidonHashService } from '@privacy-pools-v2/sdk';
import { envValue } from './funding';

const raw = envValue('E2E_ACCOUNT_B_PK') ?? envValue('DEV_PK2');
const B = privateKeyToAccount(raw.startsWith('0x') ? raw : `0x${raw}`);
const addressHash = keccak256(toBytes(B.address));
const sig = await B.signTypedData({
  domain: { name: 'Standardized Secret Derivation', version: '1', verifyingContract: '0x0000000000000000000000000000000000000000', salt: keccak256(toHex(APP_IDENTIFIER)) },
  types: { SecretDerivation: [{ name: 'purpose', type: 'string' }, { name: 'addressHash', type: 'bytes32' }] },
  primaryType: 'SecretDerivation',
  message: { purpose: 'This signature is used to deterministically derive application-specific secrets from your master seed. It is not a transaction and will not cost any gas.', addressHash },
});
const cryptoService = new CryptoService();
const km = KeystoreManager.fromSignature({ signature: sig, signerAddress: B.address, addressHash, revocableKeyIndex: '0x0' }, { cryptoService });
const hashService = await PoseidonHashService.create();
const ncs = new NoteComputationService({ hashService, cryptoService });
const nds = new EvmNoteDiscoveryService({ cryptoService, hashService, noteComputationService: ncs, addressFieldConverter: new EvmAddressFieldConverter() });

const TXS = ['0x9e0adb659fcf7999d7cb6d60c8a39598f62013273ac9a5dc9cc8bb843a29901a', '0x2c10c455eee86f97bfea36bc6237caa11ec5f5e3527d844e911a0228c589c0fd'];
const res = await fetch('https://api-dev.0xbow.io/11155111/public/event-snapshot/payload?include=notes&entrypoint=0xeb3e3961008952348445513e418ad6f43c23ca9a');
const snap = await res.json();
const events = (snap.notes as any[]).filter((n) => TXS.includes(String(n.txHash).toLowerCase()));
console.log(`snapshot notes: ${snap.notes.length}, matching depositFor events: ${events.length}`);
const mapped = events.map((n) => ({ blockNumber: n.blockNumber ?? '0x0', txHash: n.txHash, hint: n.hint, ephemeralPubKey: n.ephemeralPubKey, encryptedPayload: n.encryptedPayload }));
const found = nds.scanCatchAll(mapped, km.getViewingKeyPair().privateKey, B.address);
console.log(`catch-all decrypted with B's key: ${found.length}`);
for (const d of found) console.log('  ', { txHash: d.txHash, commitment: d.commitment ?? d.note?.commitment, value: d.value ?? d.note?.value });
// Control: a recent transfer note to B should also decrypt; count how many of ALL notes decrypt for B.
const all = (snap.notes as any[]).slice(-300).map((n) => ({ blockNumber: n.blockNumber ?? '0x0', txHash: n.txHash, hint: n.hint, ephemeralPubKey: n.ephemeralPubKey, encryptedPayload: n.encryptedPayload }));
console.log(`control: of the last 300 notes, ${nds.scanCatchAll(all, km.getViewingKeyPair().privateKey, B.address).length} decrypt for B`);
