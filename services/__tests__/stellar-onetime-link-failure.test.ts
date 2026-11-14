// A one-time link is saved and shown BEFORE the relay request. When the send then fails, the
// relay decides what happens to the link, never the error text. Runs the production
// sendOneTime (with relayTransferOnce and the real Stellar relayer client) with the wallet,
// the proof and the network stubbed, then feeds its error to the transfer modal's own
// at-risk branch, extracted from components/transfer-modal-provider.tsx.
import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { Keypair } from '@stellar/stellar-sdk';
import * as sdk from '@privacy-pools-v2/stellar-sdk';

import { STELLAR_TESTNET_CONTRACTS } from '@/config/stellar-deployment';
import { relayTransferOnce } from '@/services/stellar/stellar-transfer-once';
import * as relayerModule from '@/services/stellar/stellar-relayer';
import * as sentClaims from '@/services/stellar/stellar-sent-claims';
import { isStellarAccountAddress } from '@/services/stellar/strkey';
import { stellarActionError } from '@/services/stellar/stellar-copy';

const ME = Keypair.random().publicKey();
const RECIPIENT = Keypair.random().publicKey();
const KEY = 'sent-claims-test';
const RELAYER_URL = 'https://relayer.test';
const ASSET = STELLAR_TESTNET_CONTRACTS.nativeAssetContractId;

// --- the account: production methods, wallet and network I/O stubbed ---
const accountSource = readFileSync(new URL('../stellar/stellar-account.ts', import.meta.url), 'utf8');
const accountAst = ts.createSourceFile('stellar-account.ts', accountSource, ts.ScriptTarget.Latest, true);
const accountClass = accountAst.statements.find(ts.isClassDeclaration)!;
const methods = ['sendOneTime', 'oneTimeSendFailure', 'relayOnce', 'withTransferRelayer'];
const accountBody = accountClass.members
  .filter((m) => ts.isMethodDeclaration(m) && methods.includes(m.name.getText(accountAst)))
  .map((m) => m.getText(accountAst))
  .join('\n');
const accountCode = ts.transpileModule(`class Account { ${accountBody} }; return new Account();`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The relayer's HTTP side: a committed quote, then the relay POST answered by `relay`. */
function stubRelayerHttp(opts: { expiresInMs: number; relay: () => Response | Promise<Response> }) {
  const posts: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    posts.push(url.pathname);
    if (url.pathname.endsWith('/quote/stellar/1/transfer')) {
      return Response.json({
        feeAmount: '1000', txCost: '0', gasPrice: '0',
        feeCommitment: { feeAmount: '1000', asset: ASSET, expiration: Date.now() + opts.expiresInMs, data: '0x00', signedRelayerCommitment: '0x99' },
      });
    }
    if (url.pathname.endsWith('/relay/stellar/1/transfer')) return opts.relay();
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  return posts;
}

const p = (v: number) => `0x${v.toString(16)}`;
const relayParams = (signedFeeCommitment: unknown) => ({
  proof: { proof: { pi_a: [p(1), p(2)], pi_b: [[p(3), p(4)], [p(5), p(6)]], pi_c: [p(7), p(8)] }, publicSignals: ['1', '2', '3', '4', '5', '6', '7', '8'] },
  inputNullifierNumber: 1,
  outputCommitmentNumber: 1,
  noteData: [{ hint: '0x01', data: '0x02' }],
  signedFeeCommitment,
});

/**
 * One send. `proving` runs where the SDK's relayTransfer builds its proof (between its own
 * expiry check and the relayer's relayTransfer). `afterRelay` runs once the relayer answered.
 */
async function send(opts: {
  maxFee?: bigint;
  proving?: () => Promise<void>;
  afterRelay?: () => Promise<void>;
  shouldContinue?: () => boolean;
}) {
  const storage = memoryStorage();
  const shown: unknown[] = [];
  let relayCalls = 0;
  const env = {
    relayTransferOnce, STELLAR_TESTNET_CONTRACTS, isStellarAccountAddress,
    loadStellarSdk: async () => sdk,
    trackTransferRelay: relayerModule.trackTransferRelay,
    isRelayOutcomeUnknown: relayerModule.isRelayOutcomeUnknown,
    saveSentClaim: sentClaims.saveSentClaim,
    setSentClaimTx: sentClaims.setSentClaimTx,
    removeSentClaim: sentClaims.removeSentClaim,
    sentClaimsStorage: () => storage,
    SENT_CLAIMS_KEY: KEY,
    messageOf: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  };
  const account = new Function(...Object.keys(env), accountCode)(...Object.values(env));
  const relayer = relayerModule.createStellarRelayer(sdk as never, { url: RELAYER_URL, relayerAddress: ME });
  const session = {
    delegates: {
      transfer: {
        generateNoteSecretsMap: () => new Map([['0xaa', '0x5ec']]),
        core: {
          resolveAndValidateTransactInputs: () => ({ inputNotes: [{}] }),
          getTransactOutputNotes: () => ({ recipientNotes: [{ commitment: '0x1234567890', noteAddressHash: '0xaa', value: '100', tokenId: ASSET, label: '0x1' }] }),
        },
      },
    },
    // The SDK's PoolSessionTransfer.relayTransfer order: quote check, proof, then the relayer
    // the session reaches through the account (buildSession's relayerInteractor proxy).
    relayTransfer: async (option: { selectedQuote: { relayerInfo: unknown; quote: { feeCommitment: { expiration: number } } } }) => {
      sdk.assertFeeCommitmentLive(option.selectedQuote.quote.feeCommitment.expiration);
      await opts.proving?.();
      relayCalls++;
      const active = (account as { activeRelayer: typeof relayer }).activeRelayer;
      const txHash = await active.relayTransfer(option.selectedQuote.relayerInfo as never, relayParams(option.selectedQuote.quote.feeCommitment) as never);
      await opts.afterRelay?.();
      return { txReceipt: { status: true, txHash }, spentNullifiersConfirmed: true };
    },
  };
  Object.assign(account, {
    enqueue: (fn: () => unknown) => fn(),
    requireSigner: () => ({ address: ME, generation: 1 }),
    ensureSession: async () => session,
    connectRelayer: async () => relayer,
    ensureRegistered: async () => {},
    assertStillBound: () => {},
    refreshLocal: async () => {},
  });
  let error: unknown = null;
  let result: unknown = null;
  try {
    result = await account.sendOneTime({
      maxFee: opts.maxFee ?? 5000n,
      amount: 100n,
      recipient: RECIPIENT,
      inputCommitments: ['0x1'],
      shouldContinue: opts.shouldContinue,
      onClaimReady: (notes: unknown) => shown.push(notes),
    });
  } catch (e) {
    error = e;
  }
  return { error, result, shown, relayCalls, stored: sentClaims.readSentClaims(storage, KEY) };
}

// --- the modal: its Stellar catch, up to and including the at-risk branch ---
const modalSource = readFileSync(new URL('../../components/transfer-modal-provider.tsx', import.meta.url), 'utf8');
const modalAst = ts.createSourceFile('transfer-modal-provider.tsx', modalSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let stellarCatch: ts.CatchClause | undefined;
(function find(node: ts.Node) {
  if (ts.isCatchClause(node) && node.block.getText(modalAst).includes('Stellar transfer failed')) stellarCatch = node;
  else ts.forEachChild(node, find);
})(modalAst);
const catchStatements = stellarCatch!.block.statements;
const atRiskIndex = catchStatements.findIndex((s) => ts.isIfStatement(s) && s.expression.getText(modalAst) === "receiptLifecycleRef.current === 'at-risk'");
const atRiskCode = ts.transpileModule(
  `${catchStatements.slice(0, atRiskIndex + 1).map((s) => s.getText(modalAst)).join('\n')}\nreturn 'continued';`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

/** What the modal does with the link on screen when sendOneTime throws `err`. */
function modalDecision(err: unknown, oneTimeSendSettled = false): 'kept-sent' | 'kept-unknown' | 'dropped' {
  const calls: string[] = [];
  const env = {
    err,
    oneTimeSendSettled,
    log: () => {},
    live: () => true,
    receiptLifecycleRef: { current: 'at-risk' },
    setReceiptLifecycle: (v: unknown) => calls.push(`lifecycle:${v}`),
    setRecipientImportPayload: (v: unknown) => calls.push(`payload:${v}`),
    setRecipientImportUrl: (v: unknown) => calls.push(`url:${v}`),
    setIndeterminateAttempt: (v: unknown) => calls.push(`indeterminate:${v}`),
    setOutcomeUnknown: (v: unknown) => calls.push(`unknown:${v}`),
    setStep: (v: unknown) => calls.push(`step:${v}`),
    isRelayOutcomeUnknown: relayerModule.isRelayOutcomeUnknown,
  };
  const ended = new Function(...Object.keys(env), atRiskCode)(...Object.values(env));
  if (ended === undefined && calls.length === 0) return 'kept-sent';
  if (ended === undefined && calls.includes('unknown:true') && calls.includes('step:success')) return 'kept-unknown';
  if (ended === 'continued' && calls.includes('url:null') && calls.includes('lifecycle:none')) return 'dropped';
  throw new Error(`unexpected modal path: ${calls.join(', ')}`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test('a fee quote that expires while the proof is built drops the link and the saved copy', async () => {
  const posts = stubRelayerHttp({ expiresInMs: 40, relay: () => Response.json({ txHash: '0xfeed' }) });
  const run = await send({ proving: () => sleep(80) });
  expect(run.shown).toHaveLength(1);
  expect((run.error as Error).name).toBe('FeeCommitmentExpired');
  expect(posts.some((path) => path.includes('/relay/'))).toBe(false);
  expect(run.stored).toEqual([]);
  expect(modalDecision(run.error)).toBe('dropped');
});

test('a relayer 4xx drops the link and the saved copy, even when its text says nothing of a refusal', async () => {
  stubRelayerHttp({ expiresInMs: 60_000, relay: () => Response.json({ message: 'Invalid proof for this fee commitment' }, { status: 400 }) });
  const run = await send({});
  expect(run.shown).toHaveLength(1);
  expect((run.error as Error).name).toBe('RelayerRejected');
  expect(run.stored).toEqual([]);
  expect(modalDecision(run.error)).toBe('dropped');
  expect(stellarActionError(run.error)).toContain('Invalid proof');
});

test('the fee refusal stops before anything is saved or shown', async () => {
  // On dev the transfer's fee bound is relayTransferOnce's check against the selected inputs,
  // made before the link exists. Whatever refuses before the relay request sends nothing.
  stubRelayerHttp({ expiresInMs: 60_000, relay: () => Response.json({ txHash: '0xfeed' }) });
  const run = await send({ maxFee: 999n });
  expect((run.error as Error).message).toBe("The notes picked for this payment can't cover it.");
  expect(run.shown).toEqual([]);
  expect(run.relayCalls).toBe(0);
  expect(run.stored).toEqual([]);
});

test('a note or tree error while proving, after the save, drops the link and the saved copy', async () => {
  stubRelayerHttp({ expiresInMs: 60_000, relay: () => Response.json({ txHash: '0xfeed' }) });
  for (const thrown of [new sdk.InsufficientTransactValue('0x1', '0x2'), new sdk.MerkleTreeOutOfSync('state', '0x1', '0x2')]) {
    const run = await send({ proving: async () => { throw thrown; } });
    expect(run.error).toBe(thrown);
    expect(run.shown).toHaveLength(1);
    expect(run.relayCalls).toBe(0);
    expect(run.stored).toEqual([]);
    expect(modalDecision(run.error)).toBe('dropped');
  }
});

test('a relay with no verdict whose text says "rejected" keeps the link as an unknown outcome', async () => {
  stubRelayerHttp({ expiresInMs: 60_000, relay: () => Response.json({ message: 'Upstream rejected: send deadline passed' }, { status: 503 }) });
  const run = await send({});
  expect(run.shown).toHaveLength(1);
  expect((run.error as Error).name).toBe('RelayOutcomeUnknown');
  expect((run.error as Error).message).toContain('rejected');
  expect(run.stored).toHaveLength(1);
  expect(run.stored[0].txHash).toBeNull();
  expect(modalDecision(run.error)).toBe('kept-unknown');
});

test('a relay POST that got no answer keeps the link as an unknown outcome', async () => {
  stubRelayerHttp({ expiresInMs: 60_000, relay: () => { throw new TypeError('Failed to fetch'); } });
  const run = await send({});
  expect((run.error as Error).name).toBe('RelayOutcomeUnknown');
  expect(run.stored).toHaveLength(1);
  expect(modalDecision(run.error)).toBe('kept-unknown');
});

test("the SDK's own RelayOutcomeUnknown after the relayer took the request keeps the link, even when it says rejected", async () => {
  stubRelayerHttp({ expiresInMs: 60_000, relay: () => Response.json({ txHash: '0xfeed' }) });
  const unknown = new sdk.RelayOutcomeUnknown('The relayer gave no verdict (HTTP 502: rejected by proxy); it may have sent the transaction');
  const run = await send({ afterRelay: async () => { throw unknown; } });
  expect(run.error).toBe(unknown);
  expect(run.stored).toHaveLength(1);
  expect(modalDecision(run.error)).toBe('kept-unknown');
});

test('a confirmation failure after the relayer answered with a hash keeps the link as an unknown outcome', async () => {
  stubRelayerHttp({ expiresInMs: 60_000, relay: () => Response.json({ txHash: '0xfeed' }) });
  const run = await send({ afterRelay: async () => { throw new sdk.StellarTransactionTimedOut('0xfeed', 120000); } });
  expect((run.error as Error).name).toBe('RelayOutcomeUnknown');
  expect(run.stored).toHaveLength(1);
  expect(modalDecision(run.error)).toBe('kept-unknown');
});

test('a wallet decline after the save still drops the link and reads as a rejection', async () => {
  stubRelayerHttp({ expiresInMs: 60_000, relay: () => Response.json({ txHash: '0xfeed' }) });
  const run = await send({ proving: async () => { throw new sdk.StellarWalletSignTransactionFailed('User declined access'); } });
  expect(run.stored).toEqual([]);
  expect(modalDecision(run.error)).toBe('dropped');
  expect(stellarActionError(run.error)).toBe('Transaction was rejected.');
});

test('Superseded before the relay drops the link and the saved copy, and the relayer is never asked', async () => {
  const posts = stubRelayerHttp({ expiresInMs: 60_000, relay: () => Response.json({ txHash: '0xfeed' }) });
  // Live for the check before proving, closed by the guard right before the relay request.
  let checks = 0;
  const stopped = await send({ shouldContinue: () => ++checks < 2 });
  expect((stopped.error as Error).message).toBe('Superseded');
  expect(posts.some((path) => path.includes('/relay/'))).toBe(false);
  expect(stopped.shown).toHaveLength(1);
  expect(stopped.relayCalls).toBe(0);
  expect(stopped.stored).toEqual([]);
  expect(modalDecision(stopped.error)).toBe('dropped');
});

test('an error after the send landed (the caller callback throwing) keeps the link and the success screen', async () => {
  stubRelayerHttp({ expiresInMs: 60_000, relay: () => Response.json({ txHash: '0xfeed' }) });
  const run = await send({});
  expect(run.error).toBeNull();
  expect(run.stored[0].txHash).toBe('0xfeed');
  // The same plain error that drops the link before the send must not drop it after.
  const afterSend = new Error('onSent handler failed');
  expect(modalDecision(afterSend, false)).toBe('dropped');
  expect(modalDecision(afterSend, true)).toBe('kept-sent');
});

test('a relayed send stores its hash on the saved copy', async () => {
  stubRelayerHttp({ expiresInMs: 60_000, relay: () => Response.json({ txHash: '0xfeed' }) });
  const run = await send({});
  expect(run.error).toBeNull();
  expect(run.stored).toHaveLength(1);
  expect(run.stored[0].txHash).toBe('0xfeed');
});
