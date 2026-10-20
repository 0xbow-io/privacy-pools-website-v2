import { describe, expect, test } from 'bun:test';

import {
  debugLogHaystack,
  describeCopiedLogs,
  filterDebugLogs,
  formatDebugLogCount,
  formatDebugLogLine,
  formatDebugLogs,
  isDebugLogFilterActive,
  redactNoteIdentifiers,
  stringifyLogData,
  type DebugLogEntry,
} from '../debug-log-filter';

const at = (n: number) => Date.UTC(2026, 7, 29, 12, 0, n);

const entry = (over: Partial<DebugLogEntry> & { message: string }): DebugLogEntry => ({
  timestamp: at(0),
  level: 'info',
  tag: 'SDK',
  ...over,
});

// A slice shaped like a real session: the payload is where the hashes,
// commitments and addresses live, and that is what people hunt for.
const buffer: DebugLogEntry[] = [
  entry({ timestamp: at(1), level: 'info', tag: 'SDK', message: 'deposit submitted', data: { txHash: '0xAbC123deadBEEF', chainId: 11155111 } }),
  entry({ timestamp: at(2), level: 'debug', tag: 'ImportNote', message: 'parsed receipt link', data: { label: '0x99f1' } }),
  entry({ timestamp: at(3), level: 'error', tag: 'Relayer', message: 'PoolVault_ProofContextMismatch', data: { status: 400 } }),
  entry({ timestamp: at(4), level: 'warn', tag: 'SDK', message: 'quote expired', data: { ttlMs: 60000 } }),
  entry({ timestamp: at(5), level: 'error', tag: 'ImportNote', message: 'note not found', data: { commitment: '0xabc123' } }),
];

const messages = (entries: DebugLogEntry[]) => entries.map((e) => e.message);

describe('filterDebugLogs', () => {
  test('no level, no query: the buffer comes back untouched (same array, no copy per tick)', () => {
    expect(filterDebugLogs(buffer, {})).toBe(buffer);
    expect(filterDebugLogs(buffer, { level: 'all', query: '' })).toBe(buffer);
  });

  test('a whitespace-only query is not a filter', () => {
    expect(filterDebugLogs(buffer, { query: '   ' })).toBe(buffer);
    expect(isDebugLogFilterActive({ query: '   ' })).toBe(false);
  });

  test('matches the message, case-insensitively either way round', () => {
    expect(messages(filterDebugLogs(buffer, { query: 'DEPOSIT' }))).toEqual(['deposit submitted']);
    expect(messages(filterDebugLogs(buffer, { query: 'poolvault_proofcontext' })))
      .toEqual(['PoolVault_ProofContextMismatch']);
  });

  test('matches the tag, with or without the brackets the console draws', () => {
    expect(messages(filterDebugLogs(buffer, { query: 'importnote' })))
      .toEqual(['parsed receipt link', 'note not found']);
    expect(messages(filterDebugLogs(buffer, { query: '[Relayer]' })))
      .toEqual(['PoolVault_ProofContextMismatch']);
  });

  test('matches the level word', () => {
    expect(messages(filterDebugLogs(buffer, { query: 'warn' }))).toEqual(['quote expired']);
  });

  test('matches INSIDE the payload: a tx hash and a commitment are the point of the box', () => {
    expect(messages(filterDebugLogs(buffer, { query: '0xabc123deadbeef' }))).toEqual(['deposit submitted']);
    expect(messages(filterDebugLogs(buffer, { query: '11155111' }))).toEqual(['deposit submitted']);
    // A prefix shared by a hash and a commitment in two different entries.
    expect(messages(filterDebugLogs(buffer, { query: '0xabc123' })))
      .toEqual(['deposit submitted', 'note not found']);
  });

  test('the query is literal text, not a pattern', () => {
    // '.' must not stand for "any character": 0x1.2 is not 0x142.
    const dotted = [entry({ message: 'value 0x142' })];
    expect(filterDebugLogs(dotted, { query: '0x1.2' })).toEqual([]);
    // A bare '(' would throw as a RegExp; here it is just a character.
    const paren = [entry({ message: 'press "Copy (all)"' })];
    expect(messages(filterDebugLogs(paren, { query: '(all' }))).toEqual(['press "Copy (all)"']);
    // Anchors, quantifiers and classes are all inert.
    expect(filterDebugLogs(paren, { query: '.*' })).toEqual([]);
    expect(filterDebugLogs(paren, { query: '^press' })).toEqual([]);
  });

  test('search COMPOSES with the level chip rather than replacing it', () => {
    // '0xabc123' alone matches an info row and an error row.
    expect(messages(filterDebugLogs(buffer, { level: 'error', query: '0xabc123' })))
      .toEqual(['note not found']);
    // A query that only matches a debug row yields nothing under level=error.
    expect(filterDebugLogs(buffer, { level: 'error', query: 'receipt link' })).toEqual([]);
    // The level chip alone still narrows with an empty query.
    expect(messages(filterDebugLogs(buffer, { level: 'error', query: '' })))
      .toEqual(['PoolVault_ProofContextMismatch', 'note not found']);
  });

  test('a query nothing matches yields an empty list, not the buffer', () => {
    expect(filterDebugLogs(buffer, { query: 'zzz-no-such-thing' })).toEqual([]);
  });

  test('order is preserved (the console is a chronological tail)', () => {
    expect(messages(filterDebugLogs(buffer, { query: '0x' })))
      .toEqual(['deposit submitted', 'parsed receipt link', 'note not found']);
  });
});

describe('haystack caching (typing must not re-serialise the buffer)', () => {
  test('a payload is serialised once per entry, however many keystrokes filter it', () => {
    let reads = 0;
    const spied = entry({
      message: 'costly payload',
      data: {
        get txHash() {
          reads += 1;
          return '0xfeed';
        },
      },
    });
    const entries = [spied];
    // Simulate someone typing "0xfe" one character at a time.
    for (const q of ['0', '0x', '0xf', '0xfe']) filterDebugLogs(entries, { query: q });
    expect(reads).toBe(1);
    expect(messages(filterDebugLogs(entries, { query: '0xfeed' }))).toEqual(['costly payload']);
    expect(reads).toBe(1);
  });

  test('the level chip short-circuits before any payload is serialised', () => {
    let reads = 0;
    const excluded = entry({
      level: 'debug',
      message: 'never serialised',
      data: {
        get big() {
          reads += 1;
          return 'x';
        },
      },
    });
    filterDebugLogs([excluded], { level: 'error', query: 'x' });
    expect(reads).toBe(0);
  });
});

describe('stringifyLogData (payloads that would otherwise kill the console)', () => {
  test('a bigint amount serialises instead of throwing', () => {
    const withBigint = entry({ message: 'withdraw', data: { amount: 1000000000000000000n } });
    expect(stringifyLogData(withBigint.data)).toBe('{"amount":"1000000000000000000"}');
    // ...and it is searchable, which is the reason it must not throw here.
    expect(messages(filterDebugLogs([withBigint], { query: '1000000000000000000' }))).toEqual(['withdraw']);
  });

  test('a circular payload degrades to a string instead of throwing', () => {
    const circular: Record<string, unknown> = { name: 'client' };
    circular.self = circular;
    expect(() => stringifyLogData(circular)).not.toThrow();
    expect(() => debugLogHaystack(entry({ message: 'boom', data: circular }))).not.toThrow();
  });

  test('undefined payloads contribute nothing (no trailing "undefined" on the line)', () => {
    expect(stringifyLogData(undefined)).toBe('');
    expect(formatDebugLogLine(entry({ timestamp: at(1), message: 'bare' })))
      .toBe('2026-08-29T12:00:01.000Z [INFO][SDK] bare');
  });

  test('a value JSON.stringify returns undefined for still yields text', () => {
    expect(stringifyLogData(() => 1)).not.toBe('');
  });
});

describe('formatDebugLogs', () => {
  test('one line per entry, ISO timestamp, level and tag bracketed', () => {
    expect(formatDebugLogs(buffer.slice(0, 2))).toBe(
      '2026-08-29T12:00:01.000Z [INFO][SDK] deposit submitted {"txHash":"0xAbC123deadBEEF","chainId":11155111}\n'
      + '2026-08-29T12:00:02.000Z [DEBUG][ImportNote] parsed receipt link {"label":"0x99f1"}',
    );
  });

  test('an empty selection serialises to an empty string, never "undefined"', () => {
    expect(formatDebugLogs([])).toBe('');
  });
});

describe('counters and copy wording', () => {
  test('the badge shows matching / total only while a filter is active', () => {
    expect(formatDebugLogCount(12, 340, true)).toBe('12 / 340');
    expect(formatDebugLogCount(340, 340, false)).toBe('340');
    // Honest even when everything matches: the filter IS on.
    expect(formatDebugLogCount(340, 340, true)).toBe('340 / 340');
  });

  test('isDebugLogFilterActive tracks either control', () => {
    expect(isDebugLogFilterActive({})).toBe(false);
    expect(isDebugLogFilterActive({ level: 'all', query: '' })).toBe(false);
    expect(isDebugLogFilterActive({ level: 'error' })).toBe(true);
    expect(isDebugLogFilterActive({ query: '0x' })).toBe(true);
  });

  test('the copy toast counts what reached the clipboard, and gets the plural right', () => {
    expect(describeCopiedLogs(12)).toBe('12 logs copied');
    expect(describeCopiedLogs(1)).toBe('1 log copied');
    expect(describeCopiedLogs(0)).toBe('0 logs copied');
  });

  test('copy wording carries no em dash (house rule for user-facing copy)', () => {
    expect(describeCopiedLogs(3)).not.toContain('—');
  });
});

describe('redactNoteIdentifiers', () => {
  const COMMITMENT = `0x${'ab'.repeat(32)}`;
  const NULLIFIER = `0x${'cd'.repeat(32)}`;
  const ADDRESS = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';

  test('strips a commitment out of an SDK error message', () => {
    // The usual way one escapes: SDK errors name the commitment they failed on,
    // and this text lands in a buffer that is exported wholesale into bug reports.
    const message = `note ${COMMITMENT} has already been exited`;

    const redacted = redactNoteIdentifiers(message);

    expect(redacted).not.toContain(COMMITMENT);
    expect(redacted).toBe('note 0x<redacted> has already been exited');
  });

  test('strips every identifier when a message carries more than one', () => {
    // One line pairing two of these is already a link between notes.
    const redacted = redactNoteIdentifiers(`${COMMITMENT} spent by ${NULLIFIER}`);

    expect(redacted).not.toContain(COMMITMENT);
    expect(redacted).not.toContain(NULLIFIER);
    expect(redacted).toBe('0x<redacted> spent by 0x<redacted>');
  });

  test('keeps addresses and selectors so the message stays diagnosable', () => {
    // 20 bytes and 4 bytes are below the cut. Redacting these would leave an
    // error no one can act on, which is how redaction gets removed again.
    const message = `call 0x095ea7b3 on ${ADDRESS} reverted`;

    expect(redactNoteIdentifiers(message)).toBe(message);
  });

  test('leaves text with no hex untouched', () => {
    expect(redactNoteIdentifiers('user rejected the request')).toBe(
      'user rejected the request',
    );
  });

  test('matches whatever the case the source used', () => {
    // Chain logs, the SDK and the ASP each render hex differently; a
    // case-sensitive rule would pass one spelling through.
    const upper = `0x${'AB'.repeat(32)}`;

    expect(redactNoteIdentifiers(upper)).toBe('0x<redacted>');
  });
});
