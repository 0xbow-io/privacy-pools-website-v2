// Pat's preview: the Activity panel listed his withdrawals but the recipient
// list stayed empty. Two questions, answered from the real producers:
//   1. Timing: rows that arrive after focus must appear without a refocus,
//      and an unsettled source must read 'loading', never 'empty'.
//   2. Data: do the in-memory Activity rows carry a withdrawal's recipient?
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EMPTY_HINT, EMPTY_TITLE, LOADING_TITLE } from '../../components/contacts/contacts-copy';
import {
  buildRecipientIndex,
  payoutRecordsFromActivity,
  rankRecipientSuggestions,
  recipientListState,
  withRecords,
} from '../recipient-suggestions';

const root = join(new URL('.', import.meta.url).pathname, '..', '..');
const src = (p: string) => readFileSync(join(root, p), 'utf8');
const noYield = () => Promise.resolve();
const PAYEE = '0x71c7656ec7ab88b098defb751b7401b5f6d8976f';

describe('timing: the list follows the Activity source', () => {
  test('empty and unsettled reads loading; rows arriving later show without a refocus', async () => {
    const device = await buildRecipientIndex([[]], { yieldFn: noYield });
    // The same pipeline as useRecipientSuggestions: device index + Activity rows, then rank.
    const pipeline = (rows: { type: string; fullAddress: string; timestamp: number }[], activityLoading: boolean) => {
      const index = withRecords(device, payoutRecordsFromActivity(rows));
      const suggestions = rankRecipientSuggestions(index, [], { formats: ['evm'], query: '' });
      return { suggestions, state: recipientListState({ rows: suggestions.length, query: '', deviceReady: device !== null, activityLoading }) };
    };
    expect(pipeline([], true).state).toBe('loading');
    const later = pipeline([{ type: 'Withdrawal', fullAddress: PAYEE, timestamp: 1 }], false);
    expect(later.state).toBe('list');
    expect(later.suggestions).toHaveLength(1);
    // Settled with nothing to show is the only case that says 'empty'.
    expect(pipeline([], false).state).toBe('empty');
    // A device index still building is not 'empty' either.
    expect(recipientListState({ rows: 0, query: '', deviceReady: false, activityLoading: false })).toBe('loading');
    expect(recipientListState({ rows: 0, query: '0x12', deviceReady: true, activityLoading: false })).toBe('none');
  });

  test('the hook recomputes from the Activity rows on every change, nothing computed once', () => {
    const hook = src('hooks/use-contacts.ts');
    expect(hook).toMatch(/\[data\.transactions, data\.lineageRows, data\.internalTxHashes, data\.spendClassificationPending, data\.anchorTxHashes, filterMineEvents\]/);
    expect(hook).toMatch(/useMemo\(\(\) => withRecords\(deviceIndex, activity\), \[deviceIndex, activity\]\)/);
    expect(hook).toContain('loading: isLoading || data.spendClassificationPending');
  });

  test('every state has visible copy (the empty state once imported as undefined on web)', () => {
    for (const s of [EMPTY_TITLE, EMPTY_HINT, LOADING_TITLE]) expect(typeof s === 'string' && s.trim().length > 0).toBe(true);
  });
});

describe('data: what the real rows carry', () => {
  // Captured from the prod public feed, unedited apart from leaving out the
  // two withdrawals that name an address (no third-party address committed).
  const fixture = JSON.parse(src('services/__tests__/fixtures/prod-feed-withdrawals-2026-10-28.json')) as {
    events: { type: string; address: string; txHash: string; timestamp: number; asset: { chainId: number } }[];
  };

  test('feed rows are mapped with fullAddress = event.address (the field the source reads)', () => {
    expect(src('components/pools-provider.tsx')).toContain('fullAddress: event.address,');
  });

  test('a relayed withdrawal in the real feed names no address, so it yields no recipient', () => {
    expect(fixture.events.length).toBeGreaterThan(20);
    expect(fixture.events.every((e) => e.type === 'withdrawal' && e.address === '')).toBe(true);
    // The row exactly as pools-provider builds it for these fields.
    const rows = fixture.events.map((e) => ({ type: 'Withdrawal', fullAddress: e.address, timestamp: e.timestamp * 1000, chainId: e.asset.chainId }));
    expect(payoutRecordsFromActivity(rows)).toEqual([]);
  });

  test("the note-lineage rows name a payee only from this device's own records", () => {
    // buildSpendRows: knownRecipient = recipientOf(spend.txHash), and pools-provider
    // passes recordedRecipient over the withdraw-recipients store. No other source.
    expect(src('services/activity-rows.ts')).toContain("const knownRecipient = isClaim || isSelf ? '' : (recipientOf(spend.txHash) ?? '');");
    expect(src('components/pools-provider.tsx')).toContain('recipientOf: (txHash) => recordedRecipient(txHash, withdrawRecipients),');
  });
});
