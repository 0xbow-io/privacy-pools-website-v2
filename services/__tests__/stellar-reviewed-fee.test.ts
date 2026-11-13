import { stellarWithdrawalQuote } from '@/services/stellar/stellar-withdrawal-quote';
import { RelayFeeIncreasedError } from '@/services/relayed-withdrawal';
import { stellarFeeReserve } from '@/services/stellar-fee-selection';
import { relayTransferOnce } from '@/services/stellar/stellar-transfer-once';
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { toHex } from 'viem';
import { STELLAR_TESTNET_CONTRACTS } from '@/config/stellar-deployment';
import { feeWithinReviewed, relayerFeeJitterAllowance, transferFeeBudget } from '@/services/relayer-fee-jitter';

// Run the production quote/relay methods with wallet and network I/O stubbed.
const source = readFileSync(new URL('../stellar/stellar-account.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('stellar-account.ts', source, ts.ScriptTarget.Latest, true);
const account = ast.statements.find(ts.isClassDeclaration)!;
const methods = ['relayOnce', 'withdraw', 'keepClaim'];
const body = account.members.filter(m => ts.isMethodDeclaration(m) && methods.includes(m.name.getText(ast))).map(m => m.getText(ast)).join('\n');
const code = ts.transpileModule(`class Account { ${body} }; return new Account();`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function harness() {
  const env = { transferFeeBudget, stellarWithdrawalQuote, RelayFeeIncreasedError, feeWithinReviewed, stellarFeeReserve, relayTransferOnce, STELLAR_TESTNET_CONTRACTS, toHex, loadStellarSdk: async () => ({ MAX_INPUTS: 5, MAX_OUTPUTS: 5 }) };
  return new Function(...Object.keys(env), code)(...Object.values(env));
}
const relayer = (fee: bigint) => ({ getRelayers: async () => [{}], getTransferQuote: async () => ({ feeCommitment: { feeAmount: fee.toString() } }) });
const transfer = (maxFee: bigint) => ({ amount: 10000000n, maxFee, inputCommitments: ['0x1'], recipient: { kind: 'registered', address: 'G' } });

test('transfer accepts a binding fee above the old cap and refuses only when selected funds cannot cover it', async () => {
  const account = harness();
  let calls = 0;
  const session = { delegates: { transfer: { resolveRecipient: async () => ({}) } }, relayTransfer: async () => { calls++; return { spentNullifiersConfirmed: true }; } };
  await expect(account.relayOnce(session, relayer(2849563n), transfer(2849562n))).rejects.toThrow("The notes picked for this payment can't cover it.");
  expect(calls).toBe(0);
  await account.relayOnce(session, relayer(2849562n), transfer(2849562n));
  await account.relayOnce(session, relayer(317289n), transfer(2849562n));
  expect(calls).toBe(2);
});

test('withdrawal rejects a fee above review before relay and accepts reviewed fees above the old reserve', async () => {
  const account = harness();
  let calls = 0;
  let fee = 900000n;
  const session = { relayWithdraw: async () => { calls++; return { status: true, txHash: '0x1' }; } };
  Object.assign(account, {
    enqueue: (fn: () => unknown) => fn(), requireSigner: () => ({ address: 'G', generation: 1 }),
    ensureSession: async () => session, ensureRegistered: async () => {}, assertStillBound: () => {}, refreshLocal: async () => {},
    connectRelayer: async () => ({ getRelayers: async () => [{}], getWithdrawalQuote: async () => {
      const amounts = { feeAmount: fee.toString(), amountReceived: '10000000', amountSent: (10000000n + fee).toString() };
      return { ...amounts, feeCommitment: { ...amounts, asset: STELLAR_TESTNET_CONTRACTS.nativeAssetContractId, recipient: 'G', expiration: Date.now() + 120000 } };
    } }),
  });
  const params = { amount: 10000000n, reviewedFee: 445273n, recipient: 'G', inputCommitments: ['0x1'] };
  await expect(account.withdraw(params)).rejects.toThrow('fee went up');
  expect(calls).toBe(0);
  fee = params.reviewedFee + relayerFeeJitterAllowance(params.reviewedFee);
  expect(await account.withdraw(params)).toEqual({ txHash: '0x1' });
  expect(calls).toBe(1);
  fee = 2849562n;
  expect(await account.withdraw({ ...params, reviewedFee: fee })).toEqual({ txHash: '0x1' });
  expect(calls).toBe(2);
});


test('closing a claim during its fresh quote prevents the relay', async () => {
  const account = harness();
  let live = true;
  let relays = 0;
  const session = { exportAccount: async () => ({ notes: [{ commitment: '0x1', value: '10000000', status: 'ACTIVE' }] }) };
  Object.assign(account, {
    enqueue: (fn: () => unknown) => fn(), requireSigner: () => ({ address: 'G', generation: 1 }),
    ensureSession: async () => session, ensureRegistered: async () => {}, stampClaimedNotes: async () => {},
    assertStillBound: () => {}, connectRelayer: async () => ({}), refreshLocal: async () => {},
    withTransferRelayer: (_relayer: unknown, fn: () => unknown) => fn(),
    quoteTransferFee: async () => { live = false; return 2000000n; },
    relayOnce: async (_session: unknown, _relayer: unknown, params: { guard: () => void }) => {
      params.guard(); relays++; return { txReceipt: { status: true, txHash: '0x1' } };
    },
  });
  await expect(account.keepClaim(['0x1'], { shouldContinue: () => live })).rejects.toThrow('Superseded');
  expect(relays).toBe(0);
  // The original optional-parameters call shape remains supported.
  expect(await account.keepClaim(['0x1'])).toEqual({ txHash: '0x1' });
  expect(relays).toBe(1);
});
