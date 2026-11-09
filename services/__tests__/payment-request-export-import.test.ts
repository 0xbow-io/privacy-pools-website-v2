import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

// Isolate native/storage mocks: Bun module mocks otherwise leak into other tests.
test('real export/import preserves session requests alongside SDK backups', () => {
  const result = spawnSync(process.execPath, ['--eval', `
    import { mock } from 'bun:test';
    import assert from 'node:assert/strict';
    import { parseWithMaps, stringifyWithMaps } from './services/json-maps';
    import { upgradeLegacyPaymentRequestState } from './services/payment-request-state-migration';
    import { paymentRequestStateKey } from './services/payment-request-store-read';
    const sessionData = new Map();
    globalThis.sessionStorage = {
      getItem: key => sessionData.get(key) ?? null,
      setItem: (key, value) => sessionData.set(key, value),
    };
    const saved = new Map();
    const storage = {
      get: async key => saved.get(key) ?? null,
      set: async (key, value) => { saved.set(key, value); },
    };
    mock.module('react-native', () => ({ Platform: { OS: 'web' } }));
    mock.module('@/config/chains', () => ({ getSupportedChains: () => [{ id: 1 }, { id: 10 }] }));
    mock.module('@/services/sdk-storage', () => ({
      getSdkStorageService: () => storage,
      migratePaymentRequestStateToV2Shape: async () => {},
      parseWithMaps, stringifyWithMaps, upgradeLegacyPaymentRequestState,
    }));
    mock.module('@/services/crypto-runtime', () => ({ loadSdkCore: async () => ({
      PaymentRequestStorageAdapter: class {
        constructor(chainId, store, owner) { this.key = paymentRequestStateKey(chainId, owner); }
        async saveState(state) { await storage.set(this.key, state); }
      },
    }) }));
    const { ACTIVE_APP_ENVIRONMENT } = await import('./config/app-environment');
    const { addSessionPaymentRequest, listSessionPaymentRequests } = await import('./services/session-payment-requests');
    const { exportAllPaymentRequests, serializePaymentRequestBackup, importAllPaymentRequests } = await import('./services/payment-request-recovery');
    const { encodePaymentRequestPayloadForUrl } = await import('./services/payment-request-codec');
    const { getPaymentRequestRevision } = await import('./services/payment-request-revision');
    const owner = '0x' + 'ab'.repeat(20);
    const other = '0x' + 'cd'.repeat(20);
    const hash = n => '0x' + n.toString(16).padStart(64, '0');
    const token = '0x' + 'ee'.repeat(20);
    const makeRecord = (chainId, recipient = owner, signed = false) => {
      const payload = {
        kind: 'ppv2-payment-request', version: 2,
        requestId: 'e63ec791-8595-4a94-a292-6840b7639ee6', chainId,
        recipientAddress: recipient, recipientViewingPubKey: hash(4),
        tokenId: token, amount: '0x1234', createdAt: '2026-10-06T12:00:00.000Z',
        ...(signed ? { signature: { signer: recipient, signature: '0x' + '12'.repeat(65), signedAt: '2026-10-06T12:00:00.000Z' } } : {}),
      };
      return {
        requestId: payload.requestId, chainId, owner: recipient,
        tokenAddress: token, amount: payload.amount, createdAtMs: Date.parse(payload.createdAt),
        payLink: 'https://example.com/pay#' + encodePaymentRequestPayloadForUrl(payload), signed,
      };
    };
    const first = makeRecord(1);
    const second = makeRecord(10, owner, true);
    addSessionPaymentRequest(first);
    addSessionPaymentRequest(second);
    addSessionPaymentRequest(makeRecord(1, other));
    assert.equal(listSessionPaymentRequests(owner).length, 2, 'same ID on another chain/owner must coexist');
    const before = [...sessionData.entries()];
    const backup = await exportAllPaymentRequests(owner.toUpperCase());
    assert.deepEqual([...sessionData.entries()], before, 'export must not mutate storage');
    assert.equal(backup.sessionRequests.length, 2);
    assert.equal(backup.version, 2);
    assert.deepEqual(backup.chains, {});
    const raw = serializePaymentRequestBackup(backup);
    sessionData.clear(); // New browser session: nothing survives except the file.
    const revision = getPaymentRequestRevision();
    assert.equal((await importAllPaymentRequests(raw, owner)).restored, 2);
    assert.ok(getPaymentRequestRevision() > revision);
    assert.deepEqual(listSessionPaymentRequests(owner), [second, first]);
    assert.equal((await importAllPaymentRequests(raw, owner)).skipped, 2);
    assert.deepEqual((await exportAllPaymentRequests(owner)).sessionRequests, backup.sessionRequests);
    // Malformed metadata, wrong owner, environment and link mismatches reject without writes.
    const snapshot = [...sessionData.entries()];
    for (const patch of [
      { sessionRequests: {} }, { sessionRequests: undefined },
      { sessionRequests: [first, { ...second, amount: 'bad' }] },
      { sessionRequests: [{ ...first, owner: other }] },
      { sessionRequests: [{ ...first, amount: '0x5678' }] },
      { sessionRequests: [{ ...first, payLink: 'javascript:alert(1)' }] },
      { environment: ACTIVE_APP_ENVIRONMENT === 'prod' ? 'staging' : 'prod' },
      { environment: undefined },
      // A v2 file relabelled v1 keeps its environment, and is still checked.
      { version: 1, environment: ACTIVE_APP_ENVIRONMENT === 'prod' ? 'staging' : 'prod' },
    ]) {
      await assert.rejects(importAllPaymentRequests(serializePaymentRequestBackup({ ...backup, ...patch }), owner));
      assert.deepEqual([...sessionData.entries()], snapshot);
    }
    await assert.rejects(importAllPaymentRequests(raw, other));
    const sdkRecord = {
      paymentId: hash(1), noteAddressHashes: [hash(2)], noteSecretsMap: new Map([[hash(2), hash(3)]]),
      amount: '0x1234', tokenId: token, tag: hash(5), paymentPubKey: hash(6),
      paymentPrivKey: hash(7), recipientAddress: owner, status: 'OPEN',
      createdAt: '0x19794ba2c00', fulfilledByCommitments: [], consumedSlots: [],
    };
    // A saved request owned by another account fails the whole import, before
    // either store changes, even when the session rows are this owner's.
    const foreignChain = { ...backup, chains: { '1': { requests: [{ ...sdkRecord, paymentId: hash(9), recipientAddress: other }] } } };
    const sessionBefore = [...sessionData.entries()];
    const savedBefore = [...saved.entries()];
    await assert.rejects(importAllPaymentRequests(serializePaymentRequestBackup(foreignChain), owner), /another account/);
    assert.deepEqual([...sessionData.entries()], sessionBefore);
    assert.deepEqual([...saved.entries()], savedBefore);
    saved.set(paymentRequestStateKey(1, owner), { requests: [sdkRecord] });
    const mixed = serializePaymentRequestBackup(await exportAllPaymentRequests(owner));
    sessionData.clear(); saved.clear();
    assert.equal((await importAllPaymentRequests(mixed, owner)).restored, 3);
    assert.equal(listSessionPaymentRequests(owner).length, 2);
    assert.deepEqual(saved.get(paymentRequestStateKey(1, owner)).requests[0], sdkRecord);
    assert.equal((await importAllPaymentRequests(mixed, owner)).skipped, 3);
    const old = { kind: 'ppv2-payment-request-backup', version: 1, createdAt: '', chains: { '1': { requests: [sdkRecord] } } };
    saved.clear(); sessionData.clear();
    assert.equal((await importAllPaymentRequests(serializePaymentRequestBackup(old), owner)).restored, 1);
    assert.equal(listSessionPaymentRequests(owner).length, 0);
    assert.equal(saved.get(paymentRequestStateKey(1, owner)).requests[0].paymentPrivKey, hash(7));
    // A single link has the same ownership and duplicate rules as a backup.
    sessionData.clear(); saved.clear();
    assert.equal((await importAllPaymentRequests(first.payLink, owner)).restored, 1);
    const importedLink = listSessionPaymentRequests(owner)[0];
    assert.equal(importedLink.payLink, first.payLink);
    assert.equal((await importAllPaymentRequests(first.payLink, owner)).skipped, 1);
    assert.equal(listSessionPaymentRequests(owner)[0].createdAtMs, importedLink.createdAtMs);
    await assert.rejects(importAllPaymentRequests(first.payLink, other));
    assert.equal(listSessionPaymentRequests(other).length, 0);
    const { decodePaymentRequestPayloadFromUrl } = await import('./services/payment-request-codec');
    const signedPayload = decodePaymentRequestPayloadFromUrl(second.payLink.split('/pay#')[1]);
    assert.equal((await importAllPaymentRequests(JSON.stringify(signedPayload), owner, 'https://example.com')).restored, 1);
    assert.equal(listSessionPaymentRequests(owner).find(r => r.chainId === 10).payLink, second.payLink);
    // Local state wins, even when the backup has an older date for the same request.
    addSessionPaymentRequest({ ...first, createdAtMs: first.createdAtMs + 1000 });
    assert.equal((await importAllPaymentRequests(raw, owner)).skipped, 2);
    assert.equal(listSessionPaymentRequests(owner).find(r => r.chainId === 1).createdAtMs, first.createdAtMs + 1000);
    // A row that would fail import is left out of the export instead of failing it.
    const stray = { ...first, requestId: '00000000-0000-4000-8000-000000000000' };
    addSessionPaymentRequest(stray);
    saved.set(paymentRequestStateKey(1, owner), { requests: [sdkRecord] });
    const robust = await exportAllPaymentRequests(owner);
    assert.equal(robust.chains['1'].requests.length, 1);
    assert.ok(robust.sessionRequests.length > 0);
    assert.ok(!robust.sessionRequests.some(r => r.requestId === stray.requestId));
    saved.clear();
    // A failed sessionStorage write must still be visible through the memory fallback.
    sessionData.clear();
    globalThis.sessionStorage.setItem = () => { throw new Error('Quota exceeded'); };
    assert.equal((await importAllPaymentRequests(raw, owner)).restored, 2);
    assert.equal(listSessionPaymentRequests(owner).length, 2);
    assert.equal((await exportAllPaymentRequests(owner)).sessionRequests.length, 2);
    console.log('Session-only, mixed, old-format, single-link, duplicate, storage-failure and invalid imports passed.');
  `], { cwd: process.cwd(), encoding: 'utf8' });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
});
