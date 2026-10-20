// Turning a prepared ppUSDC-style yield deposit into the native (ppETH) one.
//
// The SDK builds one shape: an ERC-20 yield deposit. prepareYieldDeposit takes
// the ordinary Entrypoint.deposit calldata it just proved, re-encodes it as
// PPRouter.depositExactShares(proof, noteData, aspCiphertext, maxUnderlyingIn)
// and hands back an approve() to submit first. It has no native variant —
// `depositExactSharesNative` appears nowhere in packages/sdk as of v2.0, and
// the vendored build's PP_ROUTER_DEPOSIT_ABI carries only the ERC-20 entry —
// so until the SDK grows one, the native call is assembled here.
//
// This is a re-encode, never a re-proof. PPRouter's two deposit entries take
// the SAME first three arguments; native mode drops the fourth because
// `msg.value` IS the ceiling (contracts/src/contracts/PPRouter.sol, v2.0):
//
//   depositExactShares(DepositProof, NoteData, bytes, uint256 maxUnderlyingIn)
//   depositExactSharesNative(DepositProof, NoteData, bytes) payable
//
// The router wraps exactly the quoted amount to WETH itself and refunds the
// remainder of msg.value in the same transaction, so overfunding for rate
// drift is free, and there is no approval to grant: a native deposit is one
// signature instead of two.
//
// NOT byte surgery. Chopping the trailing cap word off the ERC-20 calldata
// looks right and is wrong: `noteData` and `aspCiphertext` are dynamic, so the
// head carries OFFSETS measured from the start of the argument block, and
// removing a head word moves every tail 32 bytes earlier. The call would
// decode into garbage at the router. So the arguments are decoded and
// re-encoded, and the decode is proved lossless by re-encoding the ERC-20 form
// and requiring it back byte for byte before anything is signed.
//
// Everything here fails CLOSED: calldata that is not the deposit we prepared,
// a router that is not the configured one, or a cap that is not the one the
// caller sized are all errors, never a best-effort send.
//
// Pure (no wallet, no RPC) so bun tests can assert on it; CI runs services/.

import { decodeFunctionData, encodeFunctionData, toFunctionSelector, type Address, type Hex } from 'viem';
import type { PreparedYieldDeposit, PreparedYieldTransaction } from '@/services/sdk-types';

/**
 * PPRouter's deposit pair, copied from the contract (and matching the vendored
 * SDK's own PP_ROUTER_DEPOSIT_ABI for the ERC-20 entry). Kept here rather than
 * imported so a future SDK that renames its internal constant cannot silently
 * change which bytes we sign.
 */
const DEPOSIT_PROOF_INPUT = {
  name: 'proof',
  type: 'tuple',
  components: [
    { name: 'pA', type: 'uint256[2]' },
    { name: 'pB', type: 'uint256[2][2]' },
    { name: 'pC', type: 'uint256[2]' },
    { name: 'pubSignals', type: 'uint256[4]' },
  ],
} as const;

const NOTE_DATA_INPUT = {
  name: 'noteData',
  type: 'tuple',
  components: [
    { name: 'hint', type: 'bytes32' },
    { name: 'data', type: 'bytes' },
  ],
} as const;

export const PP_ROUTER_DEPOSIT_ABI = [
  {
    type: 'function',
    name: 'depositExactShares',
    inputs: [
      DEPOSIT_PROOF_INPUT,
      NOTE_DATA_INPUT,
      { name: 'aspCiphertext', type: 'bytes' },
      { name: 'maxUnderlyingIn', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
] as const;

export const PP_ROUTER_DEPOSIT_NATIVE_ABI = [
  {
    type: 'function',
    name: 'depositExactSharesNative',
    inputs: [
      DEPOSIT_PROOF_INPUT,
      NOTE_DATA_INPUT,
      { name: 'aspCiphertext', type: 'bytes' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'payable',
  },
] as const;

/** 0x-prefixed 4-byte selector of the ERC-20 entry the SDK produces. */
export const DEPOSIT_EXACT_SHARES_SELECTOR: Hex = toFunctionSelector(
  'depositExactShares((uint256[2],uint256[2][2],uint256[2],uint256[4]),(bytes32,bytes),bytes,uint256)',
);

/** 0x-prefixed 4-byte selector of the payable native entry. */
export const DEPOSIT_EXACT_SHARES_NATIVE_SELECTOR: Hex = toFunctionSelector(
  'depositExactSharesNative((uint256[2],uint256[2][2],uint256[2],uint256[4]),(bytes32,bytes),bytes)',
);

export class NativeYieldDepositError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NativeYieldDepositError';
  }
}

/** A 4-byte selector, lowercased, or null when `data` is too short to carry one. */
export function selectorOf(data: string): string | null {
  if (typeof data !== 'string' || !data.startsWith('0x') || data.length < 10) return null;
  return data.slice(0, 10).toLowerCase();
}

export type NativeDepositInputs = {
  /** The router the deployment names — the only address this may be sent to. */
  router: string;
  /** The cap the caller sized and passed to prepareYieldDeposit, in wei. */
  spendCap: bigint;
};

/**
 * The native deposit transaction for a prepared ERC-20 one.
 *
 * Checks, in order, that the prepared call: goes to the configured router; is
 * `depositExactShares`; decodes and re-encodes to the exact same bytes (so the
 * proof and note travel unchanged); binds the cap the caller sized, both in
 * the decoded argument and in `maxUnderlyingIn`; and carries no value of its
 * own. Then re-encodes the first three arguments as the payable entry and sets
 * `value` to that same cap.
 *
 * Callers submit the result ALONE: no approval, because there is no ERC-20 leg.
 */
export function toNativeYieldDeposit(
  prepared: Pick<PreparedYieldDeposit, 'depositTx' | 'maxUnderlyingIn'>,
  inputs: NativeDepositInputs,
): PreparedYieldTransaction {
  const { depositTx, maxUnderlyingIn } = prepared;
  if (!depositTx || typeof depositTx.to !== 'string' || typeof depositTx.data !== 'string') {
    throw new NativeYieldDepositError('Prepared yield deposit has no deposit transaction.');
  }
  if (depositTx.to.toLowerCase() !== inputs.router.toLowerCase()) {
    throw new NativeYieldDepositError(
      `Prepared yield deposit targets ${depositTx.to}, not the configured router ${inputs.router}.`,
    );
  }
  const selector = selectorOf(depositTx.data);
  // The SDK builds the payable entry ITSELF when the deployment carries
  // `nativeMode` (PoolSessionYieldDeposit: data = depositExactSharesNative,
  // value = maxUnderlyingIn, and no approval leg). Converting that a second
  // time is what broke every prod ppETH deposit: this guard demanded the
  // ERC-20 selector and threw on the native one the SDK had just produced.
  // Accept it and pass it through, still checking the two things that matter —
  // it goes to the configured router (above) and it funds exactly the cap the
  // caller sized. There is nothing to re-encode: the proof and note are
  // already bound in the SDK's own calldata.
  if (selector === DEPOSIT_EXACT_SHARES_NATIVE_SELECTOR.toLowerCase()) {
    // The selector alone is 4 bytes of assurance. Decode the rest so calldata
    // that is truncated or not the deposit we prepared is refused here rather
    // than reverting at the router — the fail-closed promise at the top of this
    // file has to hold on the path prod actually takes, not only on the ERC-20
    // one. NOT a byte-exact re-encode like the ERC-20 path below: there the
    // round trip proves a decode was lossless before the arguments are carried
    // into a DIFFERENT call. Here the SDK's own bytes are forwarded unchanged,
    // so re-encoding proves nothing about what gets signed, and demanding a
    // canonical encoding is exactly the kind of over-strict guard that broke
    // every prod ppETH deposit in the first place.
    let nativeArgs: readonly unknown[];
    try {
      const decoded = decodeFunctionData({ abi: PP_ROUTER_DEPOSIT_NATIVE_ABI, data: depositTx.data as Hex });
      nativeArgs = (decoded.args ?? []) as readonly unknown[];
    } catch (err) {
      throw new NativeYieldDepositError(
        `Prepared native yield deposit calldata did not decode as depositExactSharesNative: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (nativeArgs.length !== 3) {
      throw new NativeYieldDepositError(
        `Prepared native yield deposit decoded to ${nativeArgs.length} arguments, expected 3.`,
      );
    }
    const value = BigInt(depositTx.value ?? '0x0');
    if (value !== inputs.spendCap) {
      throw new NativeYieldDepositError(
        `Prepared native yield deposit carries ${value}, not the sized spend cap ${inputs.spendCap}.`,
      );
    }
    return {
      to: depositTx.to as Address,
      data: depositTx.data as Hex,
      value: `0x${inputs.spendCap.toString(16)}` as Hex,
    };
  }
  if (selector !== DEPOSIT_EXACT_SHARES_SELECTOR.toLowerCase()) {
    throw new NativeYieldDepositError(
      `Prepared yield deposit is not PPRouter.depositExactShares or depositExactSharesNative (selector ${selector ?? 'none'}).`,
    );
  }
  // A non-zero value on the ERC-20 call would mean the SDK changed shape under
  // us; sending that alongside our own value is not a conversion we understand.
  if (BigInt(depositTx.value ?? '0x0') !== 0n) {
    throw new NativeYieldDepositError('Prepared ERC-20 yield deposit carries a value; refusing to convert it.');
  }
  if (maxUnderlyingIn !== inputs.spendCap) {
    throw new NativeYieldDepositError(
      `Prepared cap ${maxUnderlyingIn} is not the sized spend cap ${inputs.spendCap}.`,
    );
  }

  let args: readonly unknown[];
  try {
    const decoded = decodeFunctionData({ abi: PP_ROUTER_DEPOSIT_ABI, data: depositTx.data as Hex });
    args = (decoded.args ?? []) as readonly unknown[];
  } catch (err) {
    throw new NativeYieldDepositError(
      `Prepared yield deposit calldata did not decode as depositExactShares: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (args.length !== 4) {
    throw new NativeYieldDepositError(`Prepared yield deposit decoded to ${args.length} arguments, expected 4.`);
  }
  if (args[3] !== maxUnderlyingIn) {
    throw new NativeYieldDepositError('Prepared yield deposit calldata does not bind the quoted spend cap.');
  }
  // Lossless-decode proof: re-encoding the ERC-20 form must give back exactly
  // the bytes the SDK produced. If it does, the three arguments carried into
  // the native call are the same ones the proof was built around.
  const roundTrip = encodeFunctionData({
    abi: PP_ROUTER_DEPOSIT_ABI,
    functionName: 'depositExactShares',
    args: args as never,
  });
  if (roundTrip.toLowerCase() !== depositTx.data.toLowerCase()) {
    throw new NativeYieldDepositError('Prepared yield deposit calldata did not survive a decode/encode round trip.');
  }

  const data = encodeFunctionData({
    abi: PP_ROUTER_DEPOSIT_NATIVE_ABI,
    functionName: 'depositExactSharesNative',
    args: [args[0], args[1], args[2]] as never,
  });
  return {
    to: depositTx.to as Address,
    data,
    // msg.value is BOTH the funding and the ceiling; the router refunds the
    // remainder in the same transaction (PPRouter.sol, step 4 of the native path).
    value: `0x${inputs.spendCap.toString(16)}` as Hex,
  };
}
