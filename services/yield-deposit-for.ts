// A deposit FOR SOMEONE ELSE into a yield pool (ppETH / ppUSDC / ppUSDT),
// assembled from the SDK's plain depositFor proof (DEV-451).
//
// The SDK's yield deposit has no recipient: prepareYieldDeposit builds a
// SELF deposit proof and re-targets it at the router. But the router is only
// a funding edge. PPRouter.depositExactShares(Native) checks that the proof's
// asset is its vault, wraps the underlying into shares, and forwards
// (proof, noteData, aspCiphertext) UNCHANGED to Entrypoint.deposit
// (contracts/src/contracts/PPRouter.sol, v2.0). Whose note it is lives in the
// proof, so a depositFor proof for the share token rides the same call.
//
// So the app prepares session.prepareDepositFor({ tokenId: share, value:
// shares, ... }), which yields Entrypoint.deposit calldata, and this module
// re-encodes its three arguments as the router entry: the same decode, prove-
// lossless, re-encode discipline as services/yield-native-deposit.ts, and the
// same shape the SDK itself builds for a self deposit.
//
// Everything fails CLOSED: calldata that is not Entrypoint.deposit, a value on
// an ERC-20 share deposit, a round trip that does not reproduce the bytes, or
// a cap below the router's own quote.
//
// Pure (no wallet, no RPC) so bun tests can assert on it.

import { decodeFunctionData, encodeFunctionData, type Address, type Hex } from 'viem';
import type { PreparedYieldDeposit, PreparedYieldTransaction } from '@/services/sdk-types';
import { PP_ROUTER_DEPOSIT_ABI, PP_ROUTER_DEPOSIT_NATIVE_ABI } from '@/services/yield-native-deposit';

/** Entrypoint.deposit, as the SDK encodes it (ENTRYPOINT_DEPOSIT_ABI, evm-sdk). */
export const ENTRYPOINT_DEPOSIT_ABI = [
  {
    type: 'function',
    name: 'deposit',
    inputs: [
      {
        name: '_proof',
        type: 'tuple',
        components: [
          { name: 'pA', type: 'uint256[2]' },
          { name: 'pB', type: 'uint256[2][2]' },
          { name: 'pC', type: 'uint256[2]' },
          { name: 'pubSignals', type: 'uint256[4]' },
        ],
      },
      {
        name: '_noteData',
        type: 'tuple',
        components: [
          { name: 'hint', type: 'bytes32' },
          { name: 'data', type: 'bytes' },
        ],
      },
      { name: '_aspCiphertext', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'payable',
  },
] as const;

/** PPRouter.quote(value) -> (underlyingNeeded, total), for the spend-cap check. */
export const PP_ROUTER_QUOTE_ABI = [
  {
    type: 'function',
    name: 'quote',
    inputs: [{ name: 'value', type: 'uint256' }],
    outputs: [
      { name: 'underlyingNeeded', type: 'uint256' },
      { name: 'total', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
] as const;

export class YieldDepositForError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YieldDepositForError';
  }
}

export type YieldDepositForInputs = {
  /** The router the verified deployment names. */
  router: string;
  /** The committed share amount (inside the proof). */
  shares: bigint;
  /** What the router may pull: the sized spend cap, bound into the call. */
  spendCap: bigint;
  /** The router's live quote for `shares`. */
  underlyingNeeded: bigint;
  /** ppETH: the payable entry, funded with the cap as msg.value. */
  native: boolean;
};

/**
 * The yield deposit for a prepared plain depositFor of the share token, in the
 * PreparedYieldDeposit shape the deposit flow already validates and submits.
 * No approvals: the flow sets the payer's exact allowance itself.
 */
export function toYieldDepositFor(
  prepared: { pendingNote: unknown; depositTx: { to: string; data: string; value?: string | null } },
  inputs: YieldDepositForInputs,
): PreparedYieldDeposit {
  const { depositTx } = prepared;
  if (!depositTx || typeof depositTx.data !== 'string') {
    throw new YieldDepositForError('Prepared deposit has no transaction.');
  }
  if (inputs.shares <= 0n) throw new YieldDepositForError('The share amount must be positive.');
  if (inputs.spendCap < inputs.underlyingNeeded) {
    // The SDK's own shape for this (InvalidYieldAmount, same wording), so the
    // flow's isCapBelowQuoteError shows the rate-moved guidance for it too.
    const err = new Error(
      `maxUnderlyingIn ${inputs.spendCap} is below the quoted underlyingNeeded ${inputs.underlyingNeeded}`,
    );
    err.name = 'InvalidYieldAmount';
    throw err;
  }
  // A share deposit is an ERC-20 deposit at the Entrypoint: any value means the
  // SDK built something else (a native-asset deposit), not the share leg.
  if (BigInt(depositTx.value ?? '0x0') !== 0n) {
    throw new YieldDepositForError('Prepared share deposit carries a value; it is not the share leg.');
  }

  let args: readonly unknown[];
  try {
    const decoded = decodeFunctionData({ abi: ENTRYPOINT_DEPOSIT_ABI, data: depositTx.data as Hex });
    args = (decoded.args ?? []) as readonly unknown[];
  } catch (err) {
    throw new YieldDepositForError(
      `Prepared deposit did not decode as Entrypoint.deposit: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (args.length !== 3) {
    throw new YieldDepositForError(`Prepared deposit decoded to ${args.length} arguments, expected 3.`);
  }
  // Lossless: the three arguments carried into the router call are the ones
  // the proof was built around.
  const roundTrip = encodeFunctionData({ abi: ENTRYPOINT_DEPOSIT_ABI, functionName: 'deposit', args: args as never });
  if (roundTrip.toLowerCase() !== depositTx.data.toLowerCase()) {
    throw new YieldDepositForError('Prepared deposit calldata did not survive a decode/encode round trip.');
  }

  const data = inputs.native
    ? encodeFunctionData({
        abi: PP_ROUTER_DEPOSIT_NATIVE_ABI,
        functionName: 'depositExactSharesNative',
        args: [args[0], args[1], args[2]] as never,
      })
    : encodeFunctionData({
        abi: PP_ROUTER_DEPOSIT_ABI,
        functionName: 'depositExactShares',
        args: [args[0], args[1], args[2], inputs.spendCap] as never,
      });
  const tx: PreparedYieldTransaction = {
    to: inputs.router as Address,
    data,
    value: inputs.native ? (`0x${inputs.spendCap.toString(16)}` as Hex) : ('0x0' as Hex),
  };
  return {
    pendingNote: prepared.pendingNote,
    approvalTxs: [],
    approvalTx: null,
    depositTx: tx,
    sharesValue: inputs.shares,
    underlyingNeeded: inputs.underlyingNeeded,
    maxUnderlyingIn: inputs.spendCap,
  };
}
