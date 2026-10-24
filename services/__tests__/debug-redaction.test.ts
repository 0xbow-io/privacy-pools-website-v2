import { beforeAll, describe, expect, test } from 'bun:test';
import { CryptoService, NoteComputationService, NoteManager, NoteStatus, PoseidonHashService, type AccountExport } from '@privacy-pools-v2/sdk';
import { keccak256 } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { encodeAccountKey } from '../account-key';
import type { SnapshotTransact } from '../api-types';
import { installDebugCapture } from '../debug-capture';
import type { DebugLogEntry } from '../debug-log-filter';
import { buildDebugRecording, debugRecordingFileName, RECORDING_SECRET_WARNING } from '../debug-recording';
import {
  ACCOUNT_KEY_BASE64_PREFIX,
  classifyFieldName,
  DEFAULT_REDACTION_LEVEL,
  REDACTION_LEVEL_INFO,
  REDACTION_LEVELS,
  redactValue,
  type RedactionLevel,
} from '../debug-redaction';

/**
 * Fixtures come from the REAL producers wherever one is pure: the account key
 * from encodeAccountKey, the pool keys from the SDK's own signature derivation,
 * note secrets from the SDK's generator, notes and the export envelope from the
 * SDK's NoteManager (a payment request typed as the SDK's AccountExport),
 * and the console / network entries from installDebugCapture itself. The
 * snapshot objects mirror the literals in sdk-provider.tsx and pools-provider.tsx,
 * and a source guard at the bottom fails if those field names change.
 */

type Hex = `0x${string}`;

const RPC_KEY = 'AbCdEfGh1234567890_xyzKLMNOP';
const RPC_URL = `https://eth-sepolia.g.alchemy.com/v2/${RPC_KEY}`;
const ASP_URL = 'https://api-dev.0xbow.io';
const ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const RECIPIENT = '0x42bacd8d0c811a2ba95e5d44f9c71d984299e308';
const TX_HASH = `0x${'ab'.repeat(32)}` as Hex;
const COMMITMENT = `0x${'1c'.repeat(32)}` as Hex;
const LABEL = `0x${'2d'.repeat(32)}` as Hex;
const NOTE_ADDRESS_HASH = `0x${'4f'.repeat(32)}` as Hex;
const PADDED_VALUE = `0x${'0'.repeat(52)}b5e620f48000` as Hex; // 0.0002 ETH

let fx: {
  address: Hex;
  signature: Hex;
  accountKey: string;
  viewingPrivateKey: Hex;
  viewingPublicKey: Hex;
  privateNullifyingKey: Hex;
  privateRevocableKey: Hex;
  noteSecret: Hex;
  depositSecret: Hex;
  slotSecret: Hex;
  nullifierHash: Hex;
  entries: DebugLogEntry[];
  snapshots: { atStart: Record<string, unknown>; atStop: Record<string, unknown> };
};

beforeAll(async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const signature = await account.signMessage({ message: 'ppv2 debug-redaction fixture' });
  const crypto = new CryptoService();
  const keys = crypto.deriveKeysFromSignature({
    signature,
    signerAddress: account.address,
    revocableKeyIndex: '0x0',
    addressHash: keccak256(account.address),
  });
  const noteSecret = crypto.generateSecret() as Hex;
  const depositSecret = crypto.generateSecret() as Hex;
  const slotSecret = crypto.generateSecret() as Hex;
  // The note's real nullifier, as the SDK computes it for the circuit.
  const ncs = new NoteComputationService({ hashService: await PoseidonHashService.create(), cryptoService: crypto });
  const nullifierHash = ncs.computeNullifier(keys.privateNullifyingKey, COMMITMENT) as Hex;
  const accountKey = encodeAccountKey({ address: account.address, signature });

  const noteManager = new NoteManager({});
  noteManager.addNote({
    noteAddressHash: NOTE_ADDRESS_HASH,
    commitment: COMMITMENT,
    value: PADDED_VALUE,
    tokenId: ETH,
    label: LABEL,
    status: NoteStatus.ACTIVE,
    ownerAddress: account.address,
    noteSecret,
    isOwned: true,
    depositSecret,
    createdAtBlock: '0x8a1b2c',
    spentAtBlock: null,
    txHash: TX_HASH,
  });
  const exported = noteManager.exportState();
  const note = exported.notes[0];

  // Log entries through the real capture: a console line that echoes a
  // secret, and an RPC request to a keyed Alchemy URL.
  const entries: DebugLogEntry[] = [];
  let t = 1_000;
  const log = (level: DebugLogEntry['level'], tag: string, message: string, data?: unknown) => {
    entries.push({ timestamp: (t += 10), level, tag, message, data });
  };
  const target = {
    console: { log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    fetch: async (url: string) => new Response(url.startsWith(ASP_URL)
      ? JSON.stringify({ transacts: [spendRow] })
      : JSON.stringify({ jsonrpc: '2.0', id: 1, result: TX_HASH })),
  } as unknown as typeof globalThis;
  // The ASP event snapshot row for the spend of that note, with its nullifier.
  const spendRow: SnapshotTransact = {
    txHash: TX_HASH,
    logIndex: 3,
    outputCommitments: [`0x${'5e'.repeat(32)}`],
    nullifierHashes: [nullifierHash],
    caller: RECIPIENT,
    withdrawnValue: '200000000000000',
    encryptedPayload: null,
    blockNumber: '9051948',
    blockTimestamp: '1758719100',
    asset: ETH,
  };
  const uninstall = installDebugCapture(log, target);
  target.console.log('[Transfer] RELAY SUBMITTED', { txHash: TX_HASH, amount: '0.0002', recipient: RECIPIENT, noteSecret });
  target.console.log(`[Debug] derived note secret ${noteSecret} for ${RECIPIENT}`);
  await target.fetch(RPC_URL, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [TX_HASH] }),
  });
  await target.fetch(`${ASP_URL}/11155111/snapshot`);
  await new Promise((r) => setTimeout(r, 0)); // the response body is logged async
  uninstall();
  // The clickstream (debug-provider.tsx onChange / onPointerDown).
  log('info', 'UI', 'input "Amount"', { value: '1.5', atMs: 123_456, sincePrevMs: 800 });
  log('info', 'UI', 'press "Send 1.5 ETH"', { box: '10,20 100x40', atMs: 124_000, sincePrevMs: 544 });
  // A payload that names the signer's account key in free text.
  log('warn', 'auth', `imported account key ${accountKey}`);

  const identity = {
    identityMode: 'wallet',
    walletAddress: account.address,
    effectiveAddress: account.address,
    sessionChainId: 11155111,
    keysReady: true,
    accountKey,
    keys: {
      viewingPublicKey: keys.viewingPublicKey,
      viewingPrivateKey: keys.viewingPrivateKey,
      privateNullifyingKey: keys.privateNullifyingKey,
      privateRevocableKey: keys.privateRevocableKey,
      revocableKeyIndex: '0x0',
    },
  };
  const pools = {
    identity: account.address,
    sessionChainNotes: [note],
    storedAccountExportsByChain: {
      11155111: {
        ...exported,
        owner: account.address,
        chainId: 11155111,
        paymentRequests: [{
          paymentId: `0x${'5a'.repeat(32)}`,
          noteAddressHashes: [NOTE_ADDRESS_HASH],
          amount: PADDED_VALUE,
          tokenId: ETH,
          tag: `0x${'6b'.repeat(32)}`,
          paymentPubKey: `0x${'7c'.repeat(32)}`,
          noteSecretsMap: [[NOTE_ADDRESS_HASH, slotSecret]],
          recipientAddress: account.address,
          status: 'OPEN',
          createdAt: '0x66f2a000',
          fulfilledByCommitments: [],
          consumedSlots: [],
        }],
      } satisfies AccountExport,
    },
    transactions: [{
      id: `${TX_HASH}-0`,
      address: '0x42ba…e308',
      fullAddress: RECIPIENT,
      type: 'Transfer',
      chain: 'Sepolia',
      chainId: 11155111,
      asset: 'ETH',
      tokenAddress: ETH,
      rawAmount: '200000000000000',
      tokenAmount: 0.0002,
      usdValue: 0.7,
      value: '0.0002 ETH',
      timestamp: 1_758_719_100,
      status: 'Completed',
      txHash: TX_HASH,
      reviewStatus: 'approved',
      aspRoot: `0x${'8d'.repeat(32)}`,
      label: LABEL,
      direction: 'out',
    }],
    internalTxHashes: [TX_HASH],
    spendClassificationPending: false,
    holdingsReady: true,
  };

  fx = {
    address: account.address,
    signature,
    accountKey,
    viewingPrivateKey: keys.viewingPrivateKey as Hex,
    viewingPublicKey: keys.viewingPublicKey as Hex,
    privateNullifyingKey: keys.privateNullifyingKey as Hex,
    privateRevocableKey: keys.privateRevocableKey as Hex,
    noteSecret,
    depositSecret,
    slotSecret,
    nullifierHash,
    entries,
    snapshots: { atStart: { identity, pools }, atStop: { identity, pools } },
  };
});

const build = (level: RedactionLevel) => buildDebugRecording(
  fx.entries,
  { startedAt: 1_000, stoppedAt: 9_000, environment: 'Staging', url: 'https://v2.privacypools.com/', snapshots: fx.snapshots },
  level,
);

const lc = (s: string) => s.toLowerCase();
const has = (text: string, value: string) => lc(text).includes(lc(value).replace(/^0x/, ''));

const spendSecrets = () => [fx.accountKey, fx.signature, fx.privateNullifyingKey, fx.privateRevocableKey, fx.noteSecret, fx.depositSecret, fx.slotSecret];

describe('the fixtures are real', () => {
  test('the account key carries the fixed base64 prefix', () => {
    expect(fx.accountKey.startsWith(ACCOUNT_KEY_BASE64_PREFIX)).toBe(true);
  });

  test('the capture really logged the secret, the tx hash and the RPC key', () => {
    const raw = JSON.stringify(fx.entries);
    expect(has(raw, fx.noteSecret)).toBe(true);
    expect(raw).toContain(RPC_KEY);
    expect(has(raw, fx.nullifierHash)).toBe(true);
    expect(has(raw, TX_HASH)).toBe(true);
  });
});

describe('Full', () => {
  test('keeps every key and detail, drops only the RPC key, and warns', () => {
    const text = build('full');
    const out = JSON.parse(text);
    expect(out.redaction).toBe('full');
    expect(out.containsSecrets).toBe(true);
    expect(out.warning).toBe(RECORDING_SECRET_WARNING);
    expect(text).not.toContain(RPC_KEY);
    expect(text).toContain('eth-sepolia.g.alchemy.com/v2/[redacted:rpc-key]');
    // The wallet signature is only ever inside the account key here.
    for (const s of spendSecrets().filter((x) => x !== fx.signature)) expect(has(text, s)).toBe(true);
    expect(has(text, fx.viewingPrivateKey)).toBe(true);
    expect(out.snapshots.atStart.identity.accountKey).toBe(fx.accountKey);
    expect(out.snapshots.atStart.pools.transactions[0].rawAmount).toBe('200000000000000');
  });
});

describe('No spending keys', () => {
  test('support exports default to removing all keys and transaction details', () => {
    expect(DEFAULT_REDACTION_LEVEL).toBe('no-tx-details');
  });

  test('removes the account key, the signature, note secrets and private keys, everywhere', () => {
    const text = build('no-spending-keys');
    const out = JSON.parse(text);
    expect(out.redaction).toBe('no-spending-keys');
    expect(out.containsSecrets).toBe(false);
    expect(out.warning).toBe(REDACTION_LEVEL_INFO['no-spending-keys'].statement);
    expect(text).not.toContain(RPC_KEY);
    for (const s of spendSecrets()) expect(has(text, s)).toBe(false);
    const id = out.snapshots.atStart.identity;
    expect(id.accountKey).toBe('[redacted:spend-key]');
    expect(id.keys.privateNullifyingKey).toBe('[redacted:spend-key]');
    expect(id.keys.privateRevocableKey).toBe('[redacted:spend-key]');
    const note = out.snapshots.atStart.pools.sessionChainNotes[0];
    expect(note.noteSecret).toBe('[redacted:spend-key]');
    expect(note.depositSecret).toBe('[redacted:spend-key]');
    expect(out.snapshots.atStart.pools.storedAccountExportsByChain['11155111'].paymentRequests[0].noteSecretsMap).toBe('[redacted:spend-key]');
  });

  test('a secret echoed inside a message or a console payload is removed', () => {
    const out = JSON.parse(build('no-spending-keys'));
    const echo = out.entries.find((e: { message: string }) => e.message.startsWith('[Debug] derived note secret'));
    expect(echo.message).toBe(`[Debug] derived note secret [redacted:spend-key] for ${RECIPIENT}`);
    const relay = out.entries.find((e: { message: string }) => e.message === '[Transfer] RELAY SUBMITTED');
    expect(has(relay.data, fx.noteSecret)).toBe(false);
    expect(relay.data).toContain('[redacted:spend-key]');
    const imported = out.entries.find((e: { tag: string }) => e.tag === 'auth');
    expect(imported.message).toBe('imported account key [redacted:spend-key]');
  });

  test('keeps the viewing key, amounts, hashes and addresses', () => {
    const text = build('no-spending-keys');
    const out = JSON.parse(text);
    const id = out.snapshots.atStart.identity;
    expect(id.keys.viewingPrivateKey).toBe(fx.viewingPrivateKey);
    expect(id.keys.viewingPublicKey).toBe(fx.viewingPublicKey);
    expect(id.walletAddress).toBe(fx.address);
    const note = out.snapshots.atStart.pools.sessionChainNotes[0];
    expect(note.value).toBe(PADDED_VALUE);
    expect(note.commitment).toBe(COMMITMENT);
    expect(note.txHash).toBe(TX_HASH);
    expect(out.snapshots.atStart.pools.transactions[0].tokenAmount).toBe(0.0002);
    expect(has(text, TX_HASH)).toBe(true);
  });
});

describe('No viewing key', () => {
  test('also removes the viewing key, keeps amounts and hashes', () => {
    const text = build('no-viewing-key');
    const out = JSON.parse(text);
    expect(out.redaction).toBe('no-viewing-key');
    expect(out.containsSecrets).toBe(false);
    for (const s of [...spendSecrets(), fx.viewingPrivateKey]) expect(has(text, s)).toBe(false);
    const id = out.snapshots.atStart.identity;
    expect(id.keys.viewingPrivateKey).toBe('[redacted:viewing-key]');
    expect(id.keys.viewingPublicKey).toBe(fx.viewingPublicKey);
    const tx = out.snapshots.atStart.pools.transactions[0];
    expect(tx.rawAmount).toBe('200000000000000');
    expect(tx.txHash).toBe(TX_HASH);
    expect(tx.label).toBe(LABEL);
    expect(out.snapshots.atStart.pools.sessionChainNotes[0].commitment).toBe(COMMITMENT);
    expect(has(text, fx.nullifierHash)).toBe(true);
  });
});

describe('No tx details', () => {
  test('removes amounts, hashes, commitments, labels, nullifiers and every address', () => {
    const text = build('no-tx-details');
    const out = JSON.parse(text);
    expect(out.redaction).toBe('no-tx-details');
    expect(out.containsSecrets).toBe(false);
    for (const s of [...spendSecrets(), fx.viewingPrivateKey, fx.viewingPublicKey, TX_HASH, COMMITMENT, LABEL, fx.nullifierHash, NOTE_ADDRESS_HASH, RECIPIENT, fx.address, PADDED_VALUE, RPC_KEY]) {
      expect(has(text, s)).toBe(false);
    }
    // The ASP snapshot response keeps its shape, without the nullifier.
    const asp = out.entries.find((e: { message: string }) => e.message.startsWith('← ') && e.message.includes('/snapshot'));
    expect(asp.data.body).toContain('"nullifierHashes":"[redacted:tx]"');
    expect(asp.data.body).toContain('"logIndex":3');
    expect(text).not.toContain('200000000000000');
    expect(text).not.toContain('0.0002');
    expect(text).not.toContain('1.5');
    const tx = out.snapshots.atStart.pools.transactions[0];
    expect(tx.tokenAmount).toBe('[redacted:tx]');
    expect(tx.timestamp).toBe('[redacted:tx]');
    expect(tx.createdAtBlock ?? out.snapshots.atStart.pools.sessionChainNotes[0].createdAtBlock).toBe('[redacted:tx]');
  });

  test('keeps the app flow: tags, messages, timings, chain id, statuses', () => {
    const out = JSON.parse(build('no-tx-details'));
    const click = out.entries.find((e: { tag: string; message: string }) => e.tag === 'UI' && e.message.startsWith('input'));
    expect(click.message).toBe('input "Amount"');
    expect(click.data).toEqual({ value: '[redacted:tx]', atMs: 123_456, sincePrevMs: 800 });
    const press = out.entries.find((e: { message: string }) => e.message.startsWith('press'));
    expect(press.message).toBe('press "Send [redacted:tx]"');
    expect(press.data.box).toBe('10,20 100x40');
    expect(out.snapshots.atStart.identity.sessionChainId).toBe(11155111);
    expect(out.snapshots.atStart.identity.identityMode).toBe('wallet');
    expect(out.snapshots.atStart.pools.transactions[0].status).toBe('Completed');
    expect(out.entries.some((e: { message: string }) => e.message.includes('eth-sepolia.g.alchemy.com/v2/[redacted:rpc-key] (eth_getTransactionReceipt)'))).toBe(true);
  });
});

describe('levels', () => {
  test('are nested: each removes at least what the one before removed', () => {
    const redactedPaths = (level: RedactionLevel) => {
      const paths = new Set<string>();
      const visit = (v: unknown, p: string) => {
        if (typeof v === 'string' && v.includes('[redacted:')) paths.add(p);
        else if (v && typeof v === 'object') for (const [k, c] of Object.entries(v)) visit(c, `${p}/${k}`);
      };
      visit(JSON.parse(build(level)).snapshots, '');
      return paths;
    };
    let prev = new Set<string>();
    for (const level of REDACTION_LEVELS) {
      const cur = redactedPaths(level);
      for (const p of prev) expect(cur.has(p)).toBe(true);
      expect(cur.size).toBeGreaterThanOrEqual(prev.size);
      prev = cur;
    }
  });

  test('file names: .json for Full, .redacted.json otherwise', () => {
    expect(debugRecordingFileName(0, 'full')).toBe('ppv2-recording-1970-01-01T00-00-00-000Z.json');
    for (const l of REDACTION_LEVELS.filter((x) => x !== 'full')) {
      expect(debugRecordingFileName(0, l)).toBe('ppv2-recording-1970-01-01T00-00-00-000Z.redacted.json');
    }
  });

  test('field names are matched case-insensitively and fail closed', () => {
    expect(classifyFieldName('VIEWING_PRIVATE_KEY')).toBe('viewing-key');
    expect(classifyFieldName('viewingPrivKey')).toBe('viewing-key');
    expect(classifyFieldName('recipientViewingPubKey')).toBe('tx');
    expect(classifyFieldName('rootSecret')).toBe('spend-key');
    expect(classifyFieldName('appSecret')).toBe('spend-key');
    expect(classifyFieldName('precommitmentSecret')).toBe('spend-key');
    expect(classifyFieldName('precommitment')).toBe('tx');
    expect(classifyFieldName('legacySignature')).toBe('spend-key');
    expect(classifyFieldName('paymentPrivKey')).toBe('spend-key');
    expect(classifyFieldName('someUnknownKey')).toBe('spend-key');
    expect(classifyFieldName('apiKey')).toBe('rpc-key');
    expect(classifyFieldName('nullifierHash')).toBe('tx');
    expect(classifyFieldName('box')).toBeNull();
    expect(classifyFieldName('sinceStartMs')).toBeNull();
  });

  test("an activity row's fee and moved amount go with the transaction details", () => {
    const row = { rawAmount: '42500000021000', relayFeeRaw: '42500000021000', movedAmountRaw: '2999957499999979000', claimCostRaw: '40' };
    const out = redactValue(row, 'no-tx-details');
    for (const key of Object.keys(row)) expect(out[key as keyof typeof row]).toBe('[redacted:tx]');
  });

  test('a short secret echoed elsewhere is removed too, as a whole word only', () => {
    const out = redactValue({
      form: { password: 's3cr', prfSecret: 4_294_967_297 },
      echoes: ['typed s3cr then retried', 'prf 4294967297 and 0x100000001', 'unrelated s3cret and xs3cr stay'],
    }, 'no-spending-keys');
    expect(out.form).toEqual({ password: '[redacted:spend-key]', prfSecret: '[redacted:spend-key]' });
    expect(out.echoes).toEqual([
      'typed [redacted:spend-key] then retried',
      'prf [redacted:spend-key] and [redacted:spend-key]',
      'unrelated s3cret and xs3cr stay',
    ]);
  });

  test('tiny values and small numbers under a secret field are not swept everywhere', () => {
    const out = redactValue({ secret: '7', seed: 42, note: 'step 7 of 42' }, 'no-spending-keys');
    expect(out).toEqual({ secret: '[redacted:spend-key]', seed: '[redacted:spend-key]', note: 'step 7 of 42' });
  });

  test('a secret in padded, bare or decimal form is still found', () => {
    const secret = `0x${'00'.repeat(2)}${'9f'.repeat(30)}`;
    const out = redactValue({
      note: { noteSecret: secret },
      echoes: [
        `bare ${secret.slice(2)}`,
        `decimal ${BigInt(secret).toString()}`,
        `calldata 0xa9059cbb${'0'.repeat(64)}${secret.slice(2)}`,
      ],
    }, 'no-spending-keys');
    expect(JSON.stringify(out)).not.toContain('9f9f9f9f');
    expect(JSON.stringify(out)).not.toContain(BigInt(secret).toString());
  });
});

const read = (rel: string) => require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', rel), 'utf8') as string;

describe('source guards', () => {
  test('the snapshot producers still use the field names these fixtures mirror', () => {
    const sdk = read('components/sdk-provider.tsx');
    for (const f of ['accountKey,', 'viewingPrivateKey:', 'privateNullifyingKey:', 'privateRevocableKey:', 'walletAddress:', 'effectiveAddress:']) expect(sdk).toContain(f);
    const pools = read('components/pools-provider.tsx');
    for (const f of ['sessionChainNotes:', 'storedAccountExportsByChain:', 'transactions:', 'rawAmount: string;', 'txHash: string;', 'fullAddress: string;']) expect(pools).toContain(f);
  });

  test('the dialog uses the redacted default and shows the red warning only on Full', () => {
    const provider = read('components/debug-provider.tsx');
    expect(provider).toContain('useState<RedactionLevel>(DEFAULT_REDACTION_LEVEL)');
    expect(provider).toContain("{level === 'full' && (");
    expect(provider).toContain('debugRecordingFileName(rec.startedAt, level)');
    expect(provider).toContain('stoppedAt: rec.stoppedAt, truncated: rec.truncated, snapshots: { atStart: rec.atStart, atStop: rec.atStop } }, level)');
  });

  test('the copy has no em dashes and no semicolons', () => {
    for (const info of Object.values(REDACTION_LEVEL_INFO)) {
      for (const s of [info.label, info.hint, info.keeps, info.statement]) {
        expect(s).not.toContain('—');
        expect(s).not.toContain(';');
      }
    }
  });
});

describe('standard base64 payloads', () => {
  // Standard base64 uses `/`, which the token matcher used to stop at.
  const secret = `0x${'5a'.repeat(32)}`;
  const withSlash = (() => {
    for (let i = 0; i < 500; i++) {
      const b64 = Buffer.from(JSON.stringify({ noteSecret: secret, pad: '?'.repeat(i) })).toString('base64');
      if (b64.includes('/')) return b64;
    }
    throw new Error('no slash-bearing encoding found');
  })();

  test('a JSON payload whose base64 holds a slash is still judged and removed', () => {
    const out = JSON.stringify(redactValue({ message: `pasted ${withSlash} here` }, 'no-spending-keys'));
    expect(out).not.toContain(withSlash);
    expect(out).toContain('pasted');
  });

  test('a URL path after the token survives when only the token decodes', () => {
    const b64url = Buffer.from(JSON.stringify({ noteSecret: secret })).toString('base64url');
    const out = JSON.stringify(redactValue({ message: `https://x.example/${b64url}/next` }, 'no-spending-keys'));
    expect(out).not.toContain(b64url);
    expect(out).toContain('/next');
  });

  test('Full keeps it', () => {
    const out = JSON.stringify(redactValue({ message: `pasted ${withSlash} here` }, 'full'));
    expect(out).toContain(withSlash);
  });
});
