// DEV-500: "Pay via Wallet" on a blind Stellar request. Checked against REAL
// vendored Stellar PoolSessions (memory storage, chain stubbed): the deposit
// built for the payer is the one the requester's own payment-request scan
// decrypts and binds to its slot, and the payer's prepareDepositFor accepts it.
import { describe, expect, test } from 'bun:test';
import { Keypair } from '@stellar/stellar-sdk';

import {
  STELLAR_KEY_APP_IDENTIFIER,
  STELLAR_TESTNET_CONTRACTS,
  STELLAR_TESTNET_NETWORK,
} from '@/config/stellar-deployment';
import { stellarSdkPaymentRequestPayload, type StellarSdkPaymentRequest } from '@/services/payment-request-codec';
import { decodeStellarPayLink, encodeStellarBlindRequest } from '@/services/stellar/stellar-request';
import { assertStellarRequestLive, buildStellarRequestDeposit, stellarTimeoutMessage, STELLAR_TIMEOUT_UNKNOWN_MESSAGE, WALLET_MINIMUM_MESSAGE } from '@/services/stellar/stellar-request-deposit';

const XLM = STELLAR_TESTNET_CONTRACTS.nativeAssetContractId;

class ReachedChain extends Error {}
const chainStub = new Proxy({}, {
  get: (_t, prop) => (prop === 'then' ? undefined : async () => { throw new ReachedChain('reached chain I/O'); }),
});

async function sessionFor(owner: string, seed: string) {
  const sdk = await import('@privacy-pools-v2/stellar-sdk');
  const derived = new sdk.StellarCryptoService().deriveKeysFromSignature({
    signature: `0x${seed.repeat(64)}` as never,
    appIdentifier: STELLAR_KEY_APP_IDENTIFIER,
    revocableKeyIndex: '0x0' as never,
  });
  const session = await sdk.StellarPoolSessionBuilder.create({
    chainId: 202,
    ownerAddress: owner,
    rpcUrl: 'http://unused.invalid',
    rpcInteractor: chainStub,
    networkPassphrase: STELLAR_TESTNET_NETWORK.networkPassphrase,
    poolContractId: STELLAR_TESTNET_CONTRACTS.poolContractId,
    keystoreContractId: STELLAR_TESTNET_CONTRACTS.keystoreContractId,
    aspRegistryContractId: STELLAR_TESTNET_CONTRACTS.aspRegistryContractId,
    ipfsGatewayUrl: 'http://unused.invalid',
    protocolKeys: { ...derived, revocableKeyIndex: '0x0' },
    persistentStorage: { type: 'memory' },
    circuitArtifactsDir: '/nonexistent',
  } as never);
  return { sdk, session };
}

/** The session's own PaymentRequestService and NoteDiscoveryService (not public API). */
function findService(root: unknown, className: string, method: string): Record<string, (...a: unknown[]) => unknown> {
  const seen = new Set<unknown>();
  const queue: unknown[] = [root];
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object' || seen.has(node) || node === chainStub) continue;
    seen.add(node);
    if ((node as object).constructor?.name === className && typeof (node as Record<string, unknown>)[method] === 'function') return node as never;
    for (const v of Object.values(node as object)) queue.push(v);
  }
  throw new Error(`no ${method}`);
}

async function setup() {
  const owner = Keypair.random().publicKey();
  const { sdk, session: requester } = await sessionFor(owner, 'ab');
  const generated = await requester.generatePaymentRequest({ amount: '0x989680', tokenId: XLM, slots: 3 }) as StellarSdkPaymentRequest;
  const decoded = decodeStellarPayLink(encodeStellarBlindRequest(stellarSdkPaymentRequestPayload(generated, 202)));
  if (decoded.format !== 'blind') throw new Error('expected blind');
  const { NoteComputationService } = sdk as unknown as { NoteComputationService: new (c: unknown) => never };
  const crypto = new sdk.StellarCryptoService();
  const noteComputation = new NoteComputationService({ hashService: await sdk.PoseidonHashService.create(), cryptoService: crypto });
  const tokenIdField = new sdk.StellarAddressFieldConverter().toTokenIdField(XLM as never);
  const params = buildStellarRequestDeposit({
    request: decoded.request,
    nativeTokenId: XLM,
    tokenIdField,
    noteComputation,
    depositSecret: crypto.generateSecret(),
  });
  return { sdk, owner, requester, generated, decoded, params, noteComputation, tokenIdField };
}

describe('Stellar wallet pay for a blind request (DEV-500)', () => {
  test("the requester's own payment-request scan finds the deposit and binds it to its first slot", async () => {
    const { requester, generated, params, noteComputation, tokenIdField } = await setup();
    expect(params.tokenId).toBe(XLM);
    expect(params.value).toBe(generated.amount);
    expect(params.noteAddressHash).toBe(generated.noteAddressHashes[0]);
    expect(params.noteData.hint.toLowerCase()).toBe(generated.tag.toLowerCase());

    const sdk = await import('@privacy-pools-v2/stellar-sdk');
    const { ephemeralPubKey, encryptedPayload } = sdk.decodeNoteData(params.noteData.data as never) as { ephemeralPubKey: string; encryptedPayload: string };
    const requests = await findService(requester, 'PaymentRequestService', 'getScannableRequests').getScannableRequests() as unknown[];
    expect(requests.length).toBe(1);
    const found = findService(requester, 'NoteDiscoveryService', 'scanPaymentRequests').scanPaymentRequests(
      [{ blockNumber: '0x1', txHash: `0x${'aa'.repeat(32)}`, hint: params.noteData.hint, ephemeralPubKey, encryptedPayload }],
      requests,
    ) as { paymentId: string; value: string; commitment: string }[];
    expect(found.length).toBe(1);
    expect(found[0].paymentId).toBe(generated.paymentId);
    expect(BigInt(found[0].value)).toBe(BigInt(generated.amount));
    // The commitment the deposit creates (same label the SDK derives from depositSecret).
    const nc = noteComputation as unknown as { computePrecommitment(a: string, b: string, c: string): string; computeLabel(a: string, b: string): string; computeFullCommitment(p: object): string };
    const label = nc.computeLabel(nc.computePrecommitment(params.noteAddressHash, tokenIdField, params.value), params.depositSecret);
    expect(found[0].commitment).toBe(nc.computeFullCommitment({ noteAddressHash: params.noteAddressHash, tokenId: tokenIdField, value: params.value, label }));
  });

  test("the payer's prepareDepositFor accepts the params and goes on to the chain", async () => {
    const { params } = await setup();
    const { session: payer } = await sessionFor(Keypair.random().publicKey(), 'cd');
    const error = await payer.prepareDepositFor(params as never).then(() => null, (e: unknown) => e as Error);
    // Past schema validation: the asset-config read hit the stubbed chain.
    expect(String(error)).toContain('reached chain I/O');
  });

  test('refuses a request for another asset or with no slot', async () => {
    const { decoded, noteComputation, tokenIdField } = await setup();
    if (decoded.format !== 'blind') throw new Error('expected blind');
    const base = { nativeTokenId: XLM, tokenIdField, noteComputation, depositSecret: '0x1' };
    expect(() => buildStellarRequestDeposit({ ...base, request: { ...decoded.request, tokenId: STELLAR_TESTNET_CONTRACTS.poolContractId } })).toThrow('not for XLM');
    expect(() => buildStellarRequestDeposit({ ...base, request: { ...decoded.request, noteSecretsMap: [] } })).toThrow('no note slots');
  });
});

describe('Stellar submit timeout wording', () => {
  test('a submit refused as too late reads as nothing sent; a receipt timeout says check activity', () => {
    expect(stellarTimeoutMessage('StellarTransactionTimedOut Transaction abc timed out after 60000ms')).toBe(STELLAR_TIMEOUT_UNKNOWN_MESSAGE);
    expect(stellarTimeoutMessage('StellarRPCCallTimedOut RPC call "getTransaction" timed out after 30000ms')).toBe(STELLAR_TIMEOUT_UNKNOWN_MESSAGE);
    expect(stellarTimeoutMessage('Transaction send failed: txTooLate')).toContain('Nothing was sent');
    expect(stellarTimeoutMessage('Payment cancelled')).toBeNull();
  });
});

test('the wallet minimum message names the pool floor from config', () => {
  expect(WALLET_MINIMUM_MESSAGE).toContain('at least 1 XLM');
});

test('a request is re-checked for expiry right before signing', async () => {
  const { session } = await sessionFor(Keypair.random().publicKey(), 'ef');
  const generated = await session.generatePaymentRequest({ amount: '0x989680', tokenId: XLM }) as StellarSdkPaymentRequest;
  const decoded = decodeStellarPayLink(encodeStellarBlindRequest(stellarSdkPaymentRequestPayload(generated, 202)));
  if (decoded.format !== 'blind') throw new Error('expected blind');
  expect(() => assertStellarRequestLive(decoded.request)).not.toThrow();
  expect(() => assertStellarRequestLive(decoded.request, Number(BigInt(generated.expiresAt!)) + 1)).toThrow('PaymentRequestExpired');
});
