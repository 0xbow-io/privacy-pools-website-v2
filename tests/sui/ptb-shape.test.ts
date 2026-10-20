import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Transaction } from '@mysten/sui/transactions';

/**
 * PTB shape assertions for the keystore + deposit hooks.
 *
 * The hooks build the Programmable Transaction Block inline inside a React
 * useCallback. We shim `react` (so the hook is a plain function) and
 * `@mysten/dapp-kit` (so `useSignAndExecuteTransaction` hands us a spy that
 * CAPTURES the built Transaction). We then call `tx.getData()` and assert the
 * moveCall target + argument shape — in particular the 0x6 Clock arg the
 * keystore set_auth_policy requires (INTL-19), and the entrypoint deposit args.
 *
 * Signing / on-chain execution is mocked; live submission is covered by the Node
 * live scripts. We only assert the unsigned PTB structure here.
 */

const CAPTURED: { tx: Transaction | null } = { tx: null };

vi.mock('react', () => ({
  useState: <T,>(init: T) => [init, () => {}] as const,
  useCallback: <T,>(fn: T) => fn,
  useRef: <T,>(init: T) => ({ current: init }),
}));

vi.mock('@mysten/dapp-kit', () => ({
  useSignAndExecuteTransaction: () => ({
    mutateAsync: async ({ transaction }: { transaction: Transaction }) => {
      CAPTURED.tx = transaction;
      return { digest: 'DIGEST_MOCK' };
    },
  }),
  // The hooks confirm finality before they report success
  // (services/sui-witness/tx-confirm.ts requireSuiTxSuccess reads
  // effects.status.status), so an empty client makes the hook throw
  // "client.waitForTransaction is not a function" and the PTB assertions below
  // never run. This stub is a SUCCEEDING transaction, which is the case this
  // test is about; the failure case has its own coverage in
  // tests/sui/error-surfacing.test.ts.
  useSuiClient: () => ({
    waitForTransaction: async ({ digest }: { digest: string }) => ({
      digest,
      effects: { status: { status: 'success' } },
    }),
  }),
}));

import { useSuiKeystore } from '@/hooks/use-sui-keystore';
import { useSuiDeposit } from '@/hooks/use-sui-deposit';

const PKG = '0x' + '1'.repeat(64);
const KS = '0x' + 'a'.repeat(64);
const POOL = '0x' + 'b'.repeat(64);
const ENTRY = '0x' + 'c'.repeat(64);
const CLOCK = '0x' + '0'.repeat(63) + '6';

beforeEach(() => {
  CAPTURED.tx = null;
});

describe('keystore set_auth_policy PTB', () => {
  it('includes the 0x6 Clock object arg (INTL-19 liveness)', async () => {
    const ks = useSuiKeystore();
    await ks.setAuthPolicy({
      packageId: PKG,
      keystoreObjectId: KS,
      authDigest: 111n,
      nullifyingKeyHash: 222n,
    });

    expect(CAPTURED.tx).not.toBeNull();
    const data = (CAPTURED.tx as Transaction).getData();
    const cmd = data.commands[0] as { MoveCall: { function: string; arguments: { Input: number }[] } };
    expect(cmd.MoveCall.function).toBe('set_auth_policy');

    // 4 args: keystore object, auth_digest, nullifying_key_hash, &Clock.
    expect(cmd.MoveCall.arguments).toHaveLength(4);

    // The LAST arg is the Clock object, resolving to 0x...06.
    const clockInputIdx = cmd.MoveCall.arguments[3].Input;
    const clockInput = data.inputs[clockInputIdx] as { UnresolvedObject?: { objectId: string } };
    expect(clockInput.UnresolvedObject?.objectId).toBe(CLOCK);
  });

  it('set_viewing_key has NO Clock arg (only keystore + viewing key)', async () => {
    const ks = useSuiKeystore();
    await ks.setViewingKey({ packageId: PKG, keystoreObjectId: KS, viewingKey: 7n });
    const data = (CAPTURED.tx as Transaction).getData();
    const cmd = data.commands[0] as { MoveCall: { function: string; arguments: unknown[] } };
    expect(cmd.MoveCall.function).toBe('set_viewing_key');
    expect(cmd.MoveCall.arguments).toHaveLength(2);
  });
});

describe('deposit PTB (entrypoint::deposit, coin-split)', () => {
  it('routes through entrypoint::deposit with the Clock arg and a split coin', async () => {
    const dep = useSuiDeposit();
    await dep.deposit({
      packageId: PKG,
      entrypointObjectId: ENTRY,
      poolObjectId: POOL,
      amount: 1_000_000n,
      proofBytes: new Uint8Array([1, 2, 3]),
      outputCommitment: 555n,
      tokenId: 9999n,
      noteHint: new Uint8Array([7]),
      noteData: new Uint8Array([8, 9]),
    });

    expect(CAPTURED.tx).not.toBeNull();
    const data = (CAPTURED.tx as Transaction).getData();

    // The moveCall is entrypoint::deposit. (coinWithBalance adds its own
    // command(s); the deposit call is the LAST command.)
    const moveCmd = data.commands.find(
      (c) => (c as { MoveCall?: { function: string } }).MoveCall?.function === 'deposit',
    ) as { MoveCall: { module: string; function: string; arguments: unknown[]; typeArguments: string[] } };
    expect(moveCmd).toBeTruthy();
    expect(moveCmd.MoveCall.module).toBe('entrypoint');

    // entrypoint::deposit(entrypoint, pool, &Clock, coin, proof, commitment,
    // tokenId, noteHint, noteData) = 9 args.
    expect(moveCmd.MoveCall.arguments).toHaveLength(9);
    // SUI is the default type argument.
    expect(moveCmd.MoveCall.typeArguments).toEqual(['0x2::sui::SUI']);

    // The third arg (index 2) is the Clock object.
    const clockArg = moveCmd.MoveCall.arguments[2] as { Input: number };
    const clockInput = data.inputs[clockArg.Input] as { UnresolvedObject?: { objectId: string } };
    expect(clockInput.UnresolvedObject?.objectId).toBe(CLOCK);
  });

  it('builds a coinWithBalance split rather than splitting tx.gas blindly', async () => {
    // The deposit sources the amount via coinWithBalance (gas-headroom aware for
    // SUI, owned-coin selection for other tokens) — NOT splitCoins(tx.gas,...).
    // Assert at least one input encodes the balance the coin is split to.
    const dep = useSuiDeposit();
    await dep.deposit({
      packageId: PKG,
      entrypointObjectId: ENTRY,
      poolObjectId: POOL,
      amount: 1_000_000n,
      proofBytes: new Uint8Array([1]),
      outputCommitment: 1n,
      tokenId: 1n,
      noteHint: new Uint8Array(0),
      noteData: new Uint8Array(0),
    });
    const data = (CAPTURED.tx as Transaction).getData();

    // coinWithBalance compiles to a $Intent command; the deposit's coin arg is a
    // Result of that intent. The OLD bug (audit #8) used splitCoins(tx.gas,...)
    // which would instead appear as a SplitCoins command operating on GasCoin.
    const hasCoinIntent = data.commands.some((c) => (c as { $Intent?: unknown }).$Intent != null);
    expect(hasCoinIntent).toBe(true);

    const hasRawGasSplit = data.commands.some((c) => {
      const sc = (c as { SplitCoins?: { coin?: { GasCoin?: unknown } } }).SplitCoins;
      return sc?.coin?.GasCoin != null;
    });
    expect(hasRawGasSplit).toBe(false);

    const depositCmd = data.commands.find(
      (c) => (c as { MoveCall?: { function: string } }).MoveCall?.function === 'deposit',
    ) as { MoveCall: { arguments: { $kind?: string }[] } };
    // The 4th arg (index 3) of deposit is the prepared coin, a Result.
    expect(depositCmd.MoveCall.arguments[3].$kind).toBe('Result');
  });
});
