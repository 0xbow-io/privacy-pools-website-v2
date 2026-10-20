// @ts-nocheck
// ONE-OFF probe: run the SDK's real discoverNotes for account B (fresh
// NoteManager) over the block window holding the two depositFor Note events,
// with a verbose logger. Tells whether the SDK pass itself drops them.
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toBytes, toHex } from 'viem';
import { APP_IDENTIFIER, CryptoService, DEFAULT_CIRCUIT_MANIFEST, KeystoreManager, NoteManager, PoolSessionBuilder } from '@privacy-pools-v2/sdk';
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

const lines: string[] = [];
const mk = (svc: string) => ({
  level: 'debug',
  child: (s: string) => mk(`${svc}/${s}`),
  debug: (m: string, o?: object) => lines.push(`[debug][${svc}] ${m} ${o ? JSON.stringify(o).slice(0, 300) : ''}`),
  info: (m: string, o?: object) => lines.push(`[info][${svc}] ${m} ${o ? JSON.stringify(o).slice(0, 300) : ''}`),
  warn: (m: string, o?: object) => lines.push(`[warn][${svc}] ${m} ${o ? JSON.stringify(o).slice(0, 500) : ''}`),
  error: (m: string, o?: object) => lines.push(`[error][${svc}] ${m} ${o ? JSON.stringify(o).slice(0, 500) : ''}`),
});
const logger = mk('root');
const nm = new NoteManager({}, { logger });

const session = await PoolSessionBuilder.fromConfig({
  chainId: 11155111,
  rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
  ownerAddress: B.address,
  deploymentBlock: '0xa6d283',
  aspUrl: 'https://api-dev.0xbow.io',
  relayers: [{ url: 'https://relayer-staging.example', name: 'staging', chainId: 11155111, chainType: 'evm', status: 'active', address: '0x0000000000000000000000000000000000000001', processorAddress: '0x7430cc030d7eb8C83E76cD983996982C8C054204' }],
  logger,
})
  .withCircuitArtifacts({ getWasm: async () => { throw new Error('no circuits in probe'); }, getZkey: async () => { throw new Error('no circuits in probe'); }, getVkey: async () => { throw new Error('no circuits in probe'); } } as any)
  .withKeystoreManager(km).withNoteManager(nm).create();

const FROM = '0xa6d103'; // full range, as the app does on every session start
console.log('running discoverNotes from', FROM);
let discovered: any[] = [];
try {
  discovered = await session.discoverNotes({ fromBlock: FROM });
} catch (e) {
  console.log('discoverNotes THREW:', (e as Error).name, (e as Error).message.slice(0, 300));
}
console.log(`discovered: ${discovered.length}`);
for (const n of discovered) console.log('  ', { commitment: n.commitment, txHash: n.txHash, value: n.value, status: n.status });
console.log(`noteManager notes: ${nm.getNotes().length}`);
console.log('--- SDK log lines (filtered) ---');
for (const l of lines) if (/warn|error|catch|Catch|discover|Discover|timestamp|Fetched|skip|Skip|dedupe|already/i.test(l)) console.log(l.slice(0, 400));
