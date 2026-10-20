import { describe, expect, test } from 'bun:test';
import { insufficientFundsRefusal } from '../../scripts/e2e/funding';
import { normalizeEntrypoints } from '../entrypoints-normalize';

describe('e2e sweep: insufficient-funds refusals', () => {
  test('geth "have N want M", as logged in run 37776352381', () => {
    const error = Object.assign(new Error('The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.'), {
      details: 'insufficient funds for gas * price + value: have 6998399873867724 want 7997573280295576',
    });
    expect(insufficientFundsRefusal(error)).toEqual({ have: 6998399873867724n });
    expect(insufficientFundsRefusal(new Error('Details: insufficient funds for gas * price + value: have 6998399873867724 want 7997573280295576'))).toEqual({ have: 6998399873867724n });
  });
  test('"balance N, need M"', () => {
    expect(insufficientFundsRefusal(new Error('insufficient funds: balance 6998399873867724, need 7997573280295576'))).toEqual({ have: 6998399873867724n });
  });
  test('no numbers: still a refusal, re-read and retry', () => {
    expect(insufficientFundsRefusal(new Error('insufficient funds for transfer'))).toEqual({ have: null });
  });
  test('any other error is not retried', () => {
    expect(insufficientFundsRefusal(new Error('nonce too low'))).toBeNull();
  });
});

describe('entrypoints feed shapes', () => {
  test('flat pools[] and the legacy chain map both normalize', () => {
    const flat = normalizeEntrypoints({ pools: [{ poolId: '4', chainId: '11155111', entrypoint: '0xeb3e', fromBlock: 1 }] } as never);
    expect(flat.pools.map((p) => [p.chainId, p.entrypoint])).toEqual([['11155111', '0xeb3e']]);
    const legacy = normalizeEntrypoints({ chains: { chain_11155111: { entrypoint: '0xabc', fromBlock: 2 } } } as never);
    expect(legacy.pools.map((p) => [p.chainId, p.entrypoint])).toEqual([['11155111', '0xabc']]);
  });
});
