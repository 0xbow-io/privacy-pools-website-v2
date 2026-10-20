import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Hash, Hex } from 'viem';
import {
  UNSEEN_POOL_READ_ANSWER,
  answerFromIndex,
  classifyPoolRead,
  routePoolRead,
  type PoolReadIndex,
} from '../pool-read-router';

const POOL = '0xAbCdEf0000000000000000000000000000000001';
const C = ('0x' + '11'.repeat(32)) as Hash;
const N = ('0x' + '22'.repeat(32)) as Hash;

function fakeIndex(state: {
  commitments?: Record<string, Hex | null>;
  spent?: Record<string, Hex | null>;
}): PoolReadIndex {
  const commitments = state.commitments ?? {};
  const spent = state.spent ?? {};
  return {
    hasCommitment: (c) => c in commitments,
    commitmentTimestamp: (c) => commitments[c] ?? null,
    isNullifierSpent: (n) => n in spent,
    nullifierSpentAt: (n) => spent[n] ?? null,
  };
}

describe('classifyPoolRead', () => {
  test('recognises commitments and spentNullifiers on the pool, case-insensitive address', () => {
    expect(classifyPoolRead({ functionName: 'commitments', address: POOL.toLowerCase(), args: [C] }, POOL)).toEqual({
      functionName: 'commitments',
      value: C,
    });
    expect(classifyPoolRead({ functionName: 'spentNullifiers', address: POOL, args: [BigInt(N)] }, POOL)).toEqual({
      functionName: 'spentNullifiers',
      value: N,
    });
  });

  test('leaves every other read alone', () => {
    expect(classifyPoolRead({ functionName: 'balanceOf', address: POOL, args: [C] }, POOL)).toBeNull();
    expect(classifyPoolRead({ functionName: 'commitments', address: '0x' + '99'.repeat(20), args: [C] }, POOL)).toBeNull();
    expect(classifyPoolRead({ functionName: 'commitments', address: POOL, args: [C, C] }, POOL)).toBeNull();
    expect(classifyPoolRead({ functionName: 'commitments', address: POOL, args: ['not-a-number'] }, POOL)).toBeNull();
    expect(classifyPoolRead(null, POOL)).toBeNull();
  });
});

describe('answerFromIndex', () => {
  test('a seen commitment answers its timestamp, or 0 while the timestamp is unverified', () => {
    expect(answerFromIndex(fakeIndex({ commitments: { [C]: '0x64' } }), { functionName: 'commitments', value: C })).toBe(100n);
    expect(answerFromIndex(fakeIndex({ commitments: { [C]: null } }), { functionName: 'commitments', value: C })).toBe(0n);
  });

  test('an unseen commitment or nullifier is null, not 0: the caller decides', () => {
    expect(answerFromIndex(fakeIndex({}), { functionName: 'commitments', value: C })).toBeNull();
    expect(answerFromIndex(fakeIndex({}), { functionName: 'spentNullifiers', value: N })).toBeNull();
  });

  test('a spent nullifier answers when it was spent, or 1 when only the fact is known', () => {
    expect(answerFromIndex(fakeIndex({ spent: { [N]: '0x2a' } }), { functionName: 'spentNullifiers', value: N })).toBe(42n);
    expect(answerFromIndex(fakeIndex({ spent: { [N]: null } }), { functionName: 'spentNullifiers', value: N })).toBe(1n);
  });
});

describe('routePoolRead never forwards', () => {
  test('answers from the built index without catching up', async () => {
    let catchUps = 0;
    const out = await routePoolRead(fakeIndex({ commitments: { [C]: '0x10' } }), { functionName: 'commitments', value: C }, async () => {
      catchUps += 1;
    });
    expect(out).toBe(16n);
    expect(catchUps).toBe(0);
  });

  test('an unseen value earns exactly one catch-up, and is answered once the index has it', async () => {
    const commitments: Record<string, Hex | null> = {};
    const index = fakeIndex({ commitments });
    let catchUps = 0;
    const out = await routePoolRead(index, { functionName: 'commitments', value: C }, async () => {
      catchUps += 1;
      commitments[C] = '0x20';
    });
    expect(out).toBe(32n);
    expect(catchUps).toBe(1);
  });

  test('still unseen after the catch-up reads "not observed", for commitments and nullifiers alike', async () => {
    let catchUps = 0;
    const catchUp = async () => {
      catchUps += 1;
    };
    expect(await routePoolRead(fakeIndex({}), { functionName: 'commitments', value: C }, catchUp)).toBe(UNSEEN_POOL_READ_ANSWER);
    expect(await routePoolRead(fakeIndex({}), { functionName: 'spentNullifiers', value: N }, catchUp)).toBe(UNSEEN_POOL_READ_ANSWER);
    expect(catchUps).toBe(2);
  });
});

describe('the RPC wrapper routes every pool read through the router', () => {
  // Source guard: the wrapper's readContract may touch the real RPC exactly
  // once, for reads that are not about a commitment or nullifier. The
  // fall-through that forwarded an unseen value was the e2e privacy gate's
  // "RPC saw a commitment in the body".
  const source = readFileSync(fileURLToPath(new URL('../sdk-setup.ts', import.meta.url)), 'utf8');
  const start = source.indexOf('  async readContract(');
  const end = source.indexOf('  getBlockNumber()', start);
  const body = source.slice(start, end);

  test('readContract exists and hands pool reads to routePoolRead', () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain('classifyPoolRead(');
    expect(body).toContain('routePoolRead(');
  });

  test('the only real read left in readContract is the non-pool passthrough', () => {
    const forwards = body.match(/inner\.readContract\(/g) ?? [];
    expect(forwards).toHaveLength(1);
    const passthrough = body.indexOf('inner.readContract(');
    const route = body.indexOf('routePoolRead(');
    expect(passthrough).toBeLessThan(route);
  });
});
