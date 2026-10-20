import { describe, expect, test } from 'bun:test';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  isLifiApprovalTarget,
  isLifiExecutor,
  lifiAddressesKnownForChain,
  lifiApprovalTargets,
} from '@/config/lifi-addresses';
import {
  assertApprovalSpender,
  assertSwapApprovalTx,
  UnexpectedSwapTxError,
} from '@/services/swap-flows';
import type { Address, Hex } from '@/services/sdk-types';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');

const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as Address;
// lifinance/contracts, deployments/{mainnet,optimism,bsc,base}.json.
const PROXY_MAINNET = '0x68E1Acfa805dcA813116Ed6507E01c38D44318f0' as Address;
const PROXY_OPTIMISM = '0x314bE5fcf0A204837896e6028C47A9e1FC2919c7' as Address;
const PROXY_BSC = '0x5741A7FfE7c39Ca175546a54985fA79211290b51' as Address;
const PROXY_BASE = '0x74a55CaDb12501A3707E9F3C5dfd8b563C6A5940' as Address;
const DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' as Address;
const EXECUTOR_MAINNET = '0xd9B2Da9C45b118e4e93A004FB1452bCDB6cC0E88' as Address;
const EXECUTOR_OPTIMISM = '0xC9E66aa9b08EB667e450e072E96F7086AD9f2c91' as Address;
const EXECUTOR_BASE = '0x4DaC9d1769b9b304cb04741DCDEb2FC14aBdF110' as Address;

const approveCalldata = (spender: string, amount = 1_000_000n) =>
  `0x095ea7b3${spender.slice(2).toLowerCase().padStart(64, '0')}${amount.toString(16).padStart(64, '0')}` as Hex;

const thrownBy = (fn: () => unknown): unknown => {
  try { fn(); } catch (err) { return err; }
  return undefined;
};

/**
 * One allowance, one spender, and this app does not get a vote.
 *
 * A swap-and-deposit asks the wallet to let a contract move the user's tokens.
 * For five weeks the flow picked that contract itself whenever the route's
 * declared `approvalAddress` disagreed with where the transaction was going,
 * and on mainnet where it was going is a contract anyone may call with
 * instructions of their choosing. An allowance there is spendable by whoever
 * reads the mempool first, and on 2026-09-21 someone did.
 *
 * These are the rules that replace the guesswork.
 */
describe('the approval spender comes from the route and is verified', () => {
  test('0x314bE5fc… is Optimism\'s published ERC20Proxy, not a stranger', () => {
    // Worth pinning: this address is why the flow started substituting its own
    // spender in the first place, on the reading that it was the wrong one. It
    // was the right one all along.
    expect(isLifiApprovalTarget(10, PROXY_OPTIMISM)).toBe(true);
  });

  test('the published proxy and diamond are approval targets on every served chain', () => {
    for (const [chainId, proxy] of [[1, PROXY_MAINNET], [10, PROXY_OPTIMISM], [56, PROXY_BSC], [8453, PROXY_BASE]] as const) {
      expect(lifiAddressesKnownForChain(chainId)).toBe(true);
      expect(isLifiApprovalTarget(chainId, proxy)).toBe(true);
      expect(isLifiApprovalTarget(chainId, DIAMOND)).toBe(true);
      // Case is not part of the answer.
      expect(isLifiApprovalTarget(chainId, proxy.toLowerCase())).toBe(true);
      expect(isLifiApprovalTarget(chainId, proxy.toUpperCase().replace('0X', '0x'))).toBe(true);
      expect(lifiApprovalTargets(chainId)).toHaveLength(2);
    }
  });

  test('no executor is ever an approval target, on any chain', () => {
    for (const chainId of [1, 10, 56, 8453]) {
      for (const executor of [EXECUTOR_MAINNET, EXECUTOR_OPTIMISM, EXECUTOR_BASE]) {
        expect(isLifiApprovalTarget(chainId, executor)).toBe(false);
      }
    }
    expect(isLifiExecutor(1, EXECUTOR_MAINNET)).toBe(true);
    expect(isLifiExecutor(10, EXECUTOR_OPTIMISM)).toBe(true);
    // An executor belongs to its own chain: the mainnet one is not Optimism's.
    expect(isLifiExecutor(10, EXECUTOR_MAINNET)).toBe(false);
  });

  test('a proxy is valid on its own chain only', () => {
    expect(isLifiApprovalTarget(1, PROXY_OPTIMISM)).toBe(false);
    expect(isLifiApprovalTarget(10, PROXY_MAINNET)).toBe(false);
    expect(isLifiApprovalTarget(56, PROXY_MAINNET)).toBe(false);
    expect(isLifiApprovalTarget(8453, PROXY_OPTIMISM)).toBe(false);
    expect(isLifiExecutor(8453, EXECUTOR_BASE)).toBe(true);
  });

  test('a declared target that checks out is returned unchanged', () => {
    expect(assertApprovalSpender(1, PROXY_MAINNET, EXECUTOR_MAINNET)).toBe(PROXY_MAINNET);
    expect(assertApprovalSpender(10, PROXY_OPTIMISM, EXECUTOR_OPTIMISM)).toBe(PROXY_OPTIMISM);
    expect(assertApprovalSpender(1, DIAMOND, DIAMOND)).toBe(DIAMOND);
  });

  test('an absent approvalAddress is refused, not filled in from the swap target', () => {
    const err = thrownBy(() => assertApprovalSpender(1, undefined, EXECUTOR_MAINNET));
    expect(err).toBeInstanceOf(UnexpectedSwapTxError);
    expect((err as Error).message).toMatch(/nothing was sent/i);
    expect((err as Error).message).not.toContain(EXECUTOR_MAINNET);
    expect((err as Error).message).not.toContain('—');
  });

  test('an unverifiable spender is refused, and the executor case says why', () => {
    const stranger = thrownBy(() => assertApprovalSpender(1, '0x7777777777777777777777777777777777777777' as Address));
    expect(stranger).toBeInstanceOf(UnexpectedSwapTxError);
    expect((stranger as Error).message).toMatch(/approval was not signed/i);
    // The validator states its own refusal; what the RUN has sent is supplied
    // by the caller, because this same validator also runs on a re-prepared
    // route with an approval already mined behind it.
    expect((stranger as Error).message).toContain('Nothing was sent.');
    expect(thrownBy(() => assertApprovalSpender(1, '0x7777777777777777777777777777777777777777' as Address, null, ''))).toBeInstanceOf(UnexpectedSwapTxError);
    expect((thrownBy(() => assertApprovalSpender(1, '0x7777777777777777777777777777777777777777' as Address, null, '')) as Error).message)
      .not.toMatch(/nothing was sent/i);
    expect((stranger as Error).message).toMatch(/deposit the token directly/i);

    const executor = thrownBy(() => assertApprovalSpender(1, EXECUTOR_MAINNET, EXECUTOR_MAINNET));
    expect(executor).toBeInstanceOf(UnexpectedSwapTxError);
    expect((executor as Error).message).toMatch(/can be called by anyone/i);
    expect((executor as Error).message).not.toContain('—');
  });

  test('a chain with no published addresses is refused rather than trusted', () => {
    const err = thrownBy(() => assertApprovalSpender(11155111, PROXY_MAINNET));
    expect(err).toBeInstanceOf(UnexpectedSwapTxError);
    expect((err as Error).message).toMatch(/nothing was sent/i);
  });
});

/**
 * The guard's own failure was subtler than the bug it was supposed to catch:
 * on the substituting branch it was handed the address the flow had just
 * chosen, so it compared that construction against itself and passed every
 * time. It has to be told the DECLARED address, and it has to say no when the
 * calldata names anything else.
 */
describe('assertSwapApprovalTx measures the calldata against the declared address', () => {
  test('accepts calldata whose spender is the declared address', () => {
    const tx = assertSwapApprovalTx(
      { to: USDC, data: approveCalldata(PROXY_MAINNET) },
      USDC,
      PROXY_MAINNET,
    );
    expect(tx.to).toBe(USDC);
  });

  test('rejects calldata that names the swap target instead of the declared address', () => {
    const err = thrownBy(() => assertSwapApprovalTx(
      { to: USDC, data: approveCalldata(EXECUTOR_MAINNET) },
      USDC,
      PROXY_MAINNET,
    ));
    expect(err).toBeInstanceOf(UnexpectedSwapTxError);
    expect((err as Error).message).toMatch(/refusing to sign it/i);
    expect((err as Error).message.toLowerCase()).toContain(EXECUTOR_MAINNET.toLowerCase());
    expect((err as Error).message).toContain(PROXY_MAINNET);
  });

  test('rejects calldata that names any other address', () => {
    const err = thrownBy(() => assertSwapApprovalTx(
      { to: USDC, data: approveCalldata('0x7777777777777777777777777777777777777777') },
      USDC,
      PROXY_MAINNET,
    ));
    expect(err).toBeInstanceOf(UnexpectedSwapTxError);
  });
});

/**
 * A source-text ratchet, because the behavioural tests above can only cover
 * the paths that exist today and this mistake was added to a path that did
 * not. The rule is mechanical: inside runSwapAndDeposit, no approve() calldata
 * may ever be built out of the route's transaction target.
 */
describe('no approval is ever built from the swap target', () => {
  test('runSwapAndDeposit builds approve() calldata from the verified spender alone', () => {
    const source = readFileSync(join(ROOT, 'services/swap-flows.ts'), 'utf8');
    const start = source.indexOf('export async function runSwapAndDeposit');
    const end = source.indexOf('export function hexToBigInt');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);

    // Every approve() this function composes inline, with the expression that
    // supplies the spender word. There are none left — the two top-ups go
    // through buildApprovalTx now — so this is a ratchet against one coming
    // back rather than a check on today's code.
    const composed = [...body.matchAll(/\$\{ERC20_APPROVE_SELECTOR\}\$\{([^}]+)\}/g)].map((m) => m[1]);
    for (const expression of composed) {
      expect(expression).toContain('spender');
      expect(expression).not.toContain('transactionTo');
      expect(expression).not.toContain('executor');
    }

    // And the helper that replaced them is only ever handed the checked
    // spender, never the route's transaction target.
    const built = [...body.matchAll(/buildApprovalTx\(([^)]*)\)/g)].map((m) => m[1]!);
    expect(built.length).toBeGreaterThan(0);
    for (const args of built) {
      expect(args).toContain('spender');
      expect(args).not.toContain('transactionTo');
    }
    // buildApprovalTx itself takes the spender it is given and nothing else.
    const helper = source.slice(source.indexOf('export function buildApprovalTx'));
    expect(helper.slice(0, helper.indexOf('\n}'))).toContain('spender.slice(2)');

    // And the spender itself is only ever the checked one.
    expect(body).toContain('assertApprovalSpender(');
    for (const call of [...body.matchAll(/assertSwapApprovalTx\([\s\S]{0,400}?\);/g)]) {
      expect(call[0]).not.toContain('transactionTo');
      expect(call[0]).toContain('spender');
    }
    expect(body).toMatch(/assertSwapApprovalTx\(/);
    // The substitution that caused the loss, by name, so a revival is loud.
    expect(body).not.toContain('needsRetarget');
  });
});
