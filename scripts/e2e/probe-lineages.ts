// @ts-nocheck
// ONE-OFF probe: which lineages of an account hold 2+ ACTIVE notes (consolidation candidates)?
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toBytes, toHex, formatEther } from 'viem';
import { APP_IDENTIFIER, CryptoService, KeystoreManager, NoteManager, PoolSessionBuilder } from '@privacy-pools-v2/sdk';
import { envValue } from './funding';
const which = process.argv[2] === 'A' ? (envValue('E2E_ACCOUNT_A_PK') ?? envValue('DEV_PK')) : (envValue('E2E_ACCOUNT_B_PK') ?? envValue('DEV_PK2'));
const acct = privateKeyToAccount(which.startsWith('0x') ? which : `0x${which}`);
const addressHash = keccak256(toBytes(acct.address));
const sig = await acct.signTypedData({ domain: { name: 'Standardized Secret Derivation', version: '1', verifyingContract: '0x0000000000000000000000000000000000000000', salt: keccak256(toHex(APP_IDENTIFIER)) }, types: { SecretDerivation: [{ name: 'purpose', type: 'string' }, { name: 'addressHash', type: 'bytes32' }] }, primaryType: 'SecretDerivation', message: { purpose: 'This signature is used to deterministically derive application-specific secrets from your master seed. It is not a transaction and will not cost any gas.', addressHash } });
const cryptoService = new CryptoService();
const km = KeystoreManager.fromSignature({ signature: sig, signerAddress: acct.address, addressHash, revocableKeyIndex: '0x0' }, { cryptoService });
const quiet = { level: 'warn', child: () => quiet, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
const nm = new NoteManager({}, { logger: quiet });
const session = await PoolSessionBuilder.fromConfig({ chainId: 11155111, rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com', ownerAddress: acct.address, deploymentBlock: '0xa6d283', aspUrl: 'https://api-dev.0xbow.io', relayers: [{ url: 'https://relayer-staging.example', name: 's', chainId: 11155111, chainType: 'evm', status: 'active', address: '0x0000000000000000000000000000000000000001', processorAddress: '0x7430cc030d7eb8C83E76cD983996982C8C054204' }], logger: quiet })
  .withCircuitArtifacts({ getWasm: async () => { throw new Error('x'); }, getZkey: async () => { throw new Error('x'); }, getVkey: async () => { throw new Error('x'); } } as any)
  .withKeystoreManager(km).withNoteManager(nm).create();
await session.discoverNotes({ fromBlock: '0xa6d103' });
const byLabel = new Map();
for (const n of nm.getNotes()) { if (String(n.status) !== 'ACTIVE' || BigInt(n.value) === 0n) continue; const g = byLabel.get(n.label) ?? []; g.push(n); byLabel.set(n.label, g); }
console.log(`${acct.address}: ${nm.getNotes().length} notes, ${[...byLabel.values()].flat().length} ACTIVE>0, lineages with 2+: ${[...byLabel.values()].filter((g) => g.length >= 2).length}`);
for (const [label, g] of [...byLabel.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 5)) console.log(`  label ${String(label).slice(0, 12)}… x${g.length}: ${g.map((n) => formatEther(BigInt(n.value))).join(', ')} ETH`);
