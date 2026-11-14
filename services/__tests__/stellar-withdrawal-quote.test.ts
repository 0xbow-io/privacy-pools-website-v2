import { expect, test } from 'bun:test';
import type { IRelayerInteractor, StellarAddress } from '@privacy-pools-v2/stellar-sdk';
import { STELLAR_TESTNET_CONTRACTS } from '@/config/stellar-deployment';
import { stellarWithdrawalQuote } from '@/services/stellar/stellar-withdrawal-quote';

const params = { amount: 10000000n, recipient: 'G-recipient', inputCount: 2 };
const asset = STELLAR_TESTNET_CONTRACTS.nativeAssetContractId;
const amounts = { feeAmount: '2849562', amountSent: '12849562', amountReceived: '10000000' };
const valid = () => ({ ...amounts, feeCommitment: { ...amounts, asset, recipient: params.recipient, expiration: Date.now() + 120000 } });
function relayer(quote: ReturnType<typeof valid>, requests: unknown[] = []) {
  return {
    getRelayers: async () => [{}],
    getWithdrawalQuote: async (_info: unknown, request: unknown) => { requests.push(request); return quote; },
  } as unknown as IRelayerInteractor<StellarAddress>;
}

test('Review requests the committed withdrawal shape without proving and accepts a fee above the old cap', async () => {
  const quote = valid();
  const requests: unknown[] = [];
  expect((await stellarWithdrawalQuote(relayer(quote, requests), params)).quote).toEqual(quote);
  expect(requests).toEqual([{ asset, commit: true, recipient: params.recipient, extraGas: false,
    amount: '10000000', shape: { n: 2, m: 2 } }]);
});

test('Review refuses misleading display amounts, wrong signed targets, and expired quotes', async () => {
  const quote = valid();
  for (const changed of [
    { ...quote, feeAmount: '317289' },
    ...[{ asset: 'wrong' }, { recipient: 'wrong' }, { amountReceived: '1' }, { amountSent: '1' }]
      .map(change => ({ ...quote, feeCommitment: { ...quote.feeCommitment, ...change } })),
  ]) {
    await expect(stellarWithdrawalQuote(relayer(changed), params)).rejects.toThrow('does not match');
  }
  quote.feeCommitment.expiration = Date.now() - 1;
  await expect(stellarWithdrawalQuote(relayer(quote), params)).rejects.toThrow('expired');
});
