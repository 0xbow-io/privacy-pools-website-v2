// Every confirmed withdrawal and send records its recipient in the recipient
// history (the store that is backed up and feeds the autocomplete).
import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

mock.module('react-native', () => ({ Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default } }));
mock.module('expo-secure-store', () => ({ getItem: () => null, setItem: () => {} }));
const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { mem.set(k, v); },
  removeItem: (k: string) => { mem.delete(k); },
};
const store = await import('../address-book-store');

const root = join(new URL('.', import.meta.url).pathname, '..', '..');
const code = (p: string) => readFileSync(join(root, p), 'utf8').replace(/^\s*\/\/.*$/gm, '');
const OWNER = '0x1111111111111111111111111111111111111111';
const PAYEE = '0x71c7656ec7ab88b098defb751b7401b5f6d8976f';
const STELLAR = 'G' + 'B'.repeat(55);

describe('the store', () => {
  test('records under the active owner, and into the device bucket when there is none', () => {
    store.setActiveRecipientOwner(OWNER);
    store.recordRecipientUseForActiveOwner(PAYEE, 1);
    expect(store.readRecipientRecords(OWNER).map((r) => r.address.toLowerCase())).toEqual([PAYEE]);
    store.setActiveRecipientOwner(null);
    store.recordRecipientUseForActiveOwner(STELLAR, 4114);
    expect(store.readRecipientRecords(null).map((r) => r.address)).toEqual([STELLAR]);
    expect(store.recipientsStorageKey(OWNER)).not.toContain(OWNER.slice(2, 12));
    // Never throws, even on junk.
    expect(() => store.recordRecipientUseForActiveOwner('junk', 1)).not.toThrow();
    expect(() => store.recordRecipientUseForActiveOwner(undefined, 1)).not.toThrow();
  });

  test('stored rows hold address, chain and day only', () => {
    const raw = JSON.parse(mem.get(store.recipientsStorageKey(OWNER))!) as Record<string, unknown>[];
    expect(Object.keys(raw[0]).sort()).toEqual(['address', 'chainId', 'lastUsedAt']);
  });

  test('the legacy-store wrapper records both', () => {
    store.setActiveRecipientOwner(OWNER);
    const legacy: unknown[] = [];
    store.recordWithdrawRecipientAndHistory({ txHash: '0x' + '1'.repeat(64), chainId: 10, recipient: '0x' + 'a'.repeat(40), timestamp: 1 }, ((e: unknown) => legacy.push(e)) as never);
    expect(legacy).toHaveLength(1);
    expect(store.readRecipientRecords(OWNER).map((r) => r.address.toLowerCase())).toContain('0x' + 'a'.repeat(40));
  });
});

describe('every payout path records', () => {
  const withdraw = code('components/withdraw-modal-provider.tsx');
  const transfer = code('components/transfer-modal-provider.tsx');
  const swap = code('components/swap-modal-provider.tsx');

  test('Withdraw EVM: plain, delayed-confirm, batch and both swap-exit paths use the recording wrapper', () => {
    const calls = withdraw.match(/recordWithdrawRecipient: recordWithdrawRecipientEverywhere \}/g) ?? [];
    expect(calls.length).toBe(5);
    expect(withdraw).not.toMatch(/recordWithdrawFee, recordWithdrawRecipient \}/);
    expect(withdraw).not.toMatch(/recordSwap, recordWithdrawRecipient \}/);
  });

  test('Withdraw Stellar and Sui (relayed and direct) record the reviewed recipient', () => {
    expect(withdraw).toContain('recordRecipientUseForActiveOwner(recipient, STELLAR_TESTNET_ID);');
    expect((withdraw.match(/recordRecipientUseForActiveOwner\(suiRecipient, SUI_TESTNET_ID\);/g) ?? []).length).toBe(2);
  });

  test('Send: every recordSentTransfer goes through the recording wrapper; Sui records too', () => {
    expect(transfer).toMatch(/function recordSentTransfer\(tx: SentTransfer\): void \{\n\s+recordSentTransferOnly\(tx\);\n\s+recordRecipientUseForActiveOwner\(tx\.recipient, tx\.chainId\);/);
    expect(transfer).not.toMatch(/import \{ recordSentTransfer \}/);
    expect(transfer).toContain('recordRecipientUseForActiveOwner(recipientAddress, SUI_TESTNET_ID);');
  });

  test('Swap: the payout and both swap-send paths record', () => {
    expect((swap.match(/recordRecipientUseForActiveOwner\(snap\.recipient/g) ?? []).length).toBe(3);
  });

  test('the owner is the session identity the contacts hook reads', () => {
    for (const f of [withdraw, transfer]) expect(f).toContain('useEffect(() => { setActiveRecipientOwner(sessionAddress ?? null); }, [sessionAddress]);');
    expect(code('hooks/use-contacts.ts')).toContain('const owner = sessionAddress ?? null;');
  });
});
