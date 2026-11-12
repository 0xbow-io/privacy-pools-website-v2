import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { toHex } from 'viem';
import { STELLAR_TRANSFER_RELAY_FEE_ESTIMATE, STELLAR_TESTNET_CONTRACTS, estimateStellarRelayFee } from '@/config/stellar-deployment';
import { feeWithinReviewed, relayerFeeJitterAllowance } from '@/services/relayer-fee-jitter';

// Run the production quote/relay methods with wallet and network I/O stubbed.
const source = readFileSync(new URL('../stellar/stellar-account.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('stellar-account.ts', source, ts.ScriptTarget.Latest, true);
const account = ast.statements.find(ts.isClassDeclaration)!;
const methods = ['quotedRelayOption', 'relayPreparedTransfer', 'withdraw'];
const body = account.members.filter(m => ts.isMethodDeclaration(m) && methods.includes(m.name.getText(ast))).map(m => m.getText(ast)).join('\n');
const code = ts.transpileModule(`class Account { ${body} }; return new Account();`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function harness() {
  const env = { feeWithinReviewed, STELLAR_TRANSFER_RELAY_FEE_ESTIMATE, STELLAR_TESTNET_CONTRACTS, estimateStellarRelayFee, toHex, loadStellarSdk: async () => ({}) };
  return new Function(...Object.keys(env), code)(...Object.values(env));
}
const prepared = (fee: bigint) => ({ relayOptions: [{ selectedQuote: { quote: { feeCommitment: { feeAmount: fee.toString() } } } }] });

test('transfer relaying rejects the reported 2.4x increase before relay, while accepting the EVM allowance', async () => {
  const account = harness();
  let calls = 0;
  const session = { relayTransfer: async () => { calls++; return { spentNullifiersConfirmed: true }; } };
  const reviewed = 317289n;
  const limit = reviewed + relayerFeeJitterAllowance(reviewed);
  await expect(account.relayPreparedTransfer(session, prepared(740000n), reviewed)).rejects.toThrow('more than the fee shown');
  await expect(account.relayPreparedTransfer(session, prepared(limit + 1n), reviewed)).rejects.toThrow('more than the fee shown');
  expect(calls).toBe(0);
  await account.relayPreparedTransfer(session, prepared(limit), reviewed);
  await account.relayPreparedTransfer(session, prepared(reviewed - 1n), reviewed);
  expect(calls).toBe(2);
  // A high estimate cannot relax the existing input reserve.
  await expect(account.relayPreparedTransfer(session, prepared(750001n), 900000n)).rejects.toThrow('more than the fee shown');
  expect(calls).toBe(2);
});

test('withdrawal rejects a fee above review before relay and preserves the existing reserve cap', async () => {
  const account = harness();
  let calls = 0;
  let fee = 900000n;
  const session = { relayWithdraw: async () => { calls++; return { status: true, txHash: '0x1' }; } };
  Object.assign(account, {
    enqueue: (fn: () => unknown) => fn(), requireSigner: () => ({ address: 'G', generation: 1 }),
    ensureSession: async () => session, ensureRegistered: async () => {}, assertStillBound: () => {}, refreshLocal: async () => {},
    connectRelayer: async () => ({ getRelayers: async () => [{}], getWithdrawalQuote: async () => ({ feeAmount: fee.toString() }) }),
  });
  const params = { amount: 10000000n, reviewedFee: 445273n, recipient: 'G', inputCommitments: ['0x1'] };
  await expect(account.withdraw(params)).rejects.toThrow('more than the fee shown');
  expect(calls).toBe(0);
  fee = params.reviewedFee + relayerFeeJitterAllowance(params.reviewedFee);
  expect(await account.withdraw(params)).toEqual({ txHash: '0x1' });
  expect(calls).toBe(1);
  fee = estimateStellarRelayFee(params.amount) + 1n;
  await expect(account.withdraw({ ...params, reviewedFee: fee })).rejects.toThrow('more than the fee shown');
  expect(calls).toBe(1);
});
