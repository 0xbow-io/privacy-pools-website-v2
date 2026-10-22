import { describe, expect, test } from 'bun:test';
import { lifiStatusSubject } from '@/services/tor-groups';

const HASH = `0x${'ab'.repeat(32)}`;

describe('what a request is about, read before it is serialized away', () => {
  test('a LI.FI status query is about the transaction it names', () => {
    expect(lifiStatusSubject(`https://li.quest/v1/status?txHash=${HASH}&fromChain=1`)).toEqual({ transaction: HASH });
    expect(lifiStatusSubject('https://li.quest/v1/status?bridge=x')).toEqual({ identifying: true });
    expect(lifiStatusSubject('https://li.quest/v1/quote?fromChain=1')).toEqual({});
  });
});
