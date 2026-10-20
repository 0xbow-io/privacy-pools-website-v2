// Local mirror of SDK types needed at page load.
// This avoids eagerly importing the full SDK (which pulls in snarkjs/ffjavascript
// and requires Node.js Buffer polyfill) just for type/enum references.
// When using the actual SDK at runtime, import directly from '@privacy-pools-v2/sdk'.

import type { YieldEarned, YieldEarnedInput } from '@privacy-pools-v2/sdk';

export enum NoteStatus {
  INACTIVE = "INACTIVE",
  PENDING = "PENDING",
  ACTIVE = "ACTIVE",
  SPENT = "SPENT",
  // A ragequit this client submitted was mined but its block is not settled yet.
  // The SDK writes this instead of EXITED because a receipt is not finality: a
  // mined exit can still be reorged out, and EXITED has no way back. Discovery
  // settles it to EXITED once the chain confirms at a final block, or back to
  // ACTIVE if the exit turns out never to have happened.
  //
  // Unspendable, and treated here exactly like an unconfirmed EXITED: a note
  // stuck in this state with no chain proof is the same loss of access that
  // finding 06 was about, so it must not simply vanish from the UI.
  EXIT_PENDING = "EXIT_PENDING",
  EXITED = "EXITED",
  // ASP pulled the label from its set. Reversible in the pinned SDK (can recover
  // to ACTIVE) and still exitable; the UI projects it to "at risk".
  REJECTED = "REJECTED",
}

// Lightweight type aliases matching the SDK's types.
// These are structural types — TypeScript uses structural typing so they're
// compatible with the real SDK types without importing the SDK.
export type Hex = `0x${string}`;
export type Hash = Hex;

/** Mirror of the SDK PendingNote (what prepare* returns and addNotes consumes); opaque here. */
export type PendingNote = { commitment: Hash } & Record<string, unknown>;
export type Secret = Hex;
export type Address = Hex;
export type PublicKey = Hex;

export type Note = {
  commitment: Hash;
  value: Hex;
  tokenId: Address;
  label: Hash;
  status: NoteStatus;
  ownerAddress: Address;
  noteSecret: Secret;
  isOwned: boolean;
  createdAtBlock: Hex;
  spentAtBlock: Hex | null;
  txHash: Hash;
  /**
   * v2.0 SDK: REQUIRED on every note the SDK stores/imports
   * (= Poseidon(ownerAddress, noteSecret)). Optional here because ppv2
   * builds UI-shape notes without it; every path that feeds notes into the
   * SDK goes through backfillNoteAddressHashes (services/note-migration.ts).
   */
  noteAddressHash?: Hash;
  /** ppv2-local lineage hint; the SDK schema drops it (pre- and post-v2.0). */
  parentCommitmentHash: Hash | null;
};

export type AccountExport = {
  notes: Note[];
  syncCursor: Hex;
  // SDK-optional envelope: the owner/chain the blob was produced for.
  // importAccount rejects a blob whose owner or chain differs from the
  // session; receipt UIs use them to label and gate imports.
  owner?: Address;
  chainId?: number;
};

// --- Aave yield (ppUSDC) mirrors ------------------------------------------
// Structural copies of the SDK's Yield types (types/Yield.ts) so the yield UI
// can type against them without eagerly importing the SDK bundle.

export type YieldDeployment = {
  /** Combined router that wraps USDC<->ppUSDC and shields/unshields via the pool. */
  ppRouter: Address;
  /** Optional stateless wrap/unwrap helper (loose-share exits after ragequit). */
  zap?: Address;
  /** ERC-4626-style yield-bearing wrapper share token (the shielded asset). */
  ppUSDC: Address;
  /** Decimals of the ppUSDC share token (18 for the current wrapper). */
  ppUSDCDecimals: number;
  /** Underlying ERC-20 the user holds/approves (e.g. USDC). */
  underlying: Address;
  /** Underlying decimals (USDC = 6). */
  underlyingDecimals: number;
  /** Human label for the underlying (e.g. "USDC"). */
  underlyingSymbol: string;
  /** Optional headline APY source label (informational, e.g. "Aave"). */
  apyLabel?: string;
  /**
   * The router runs in PPRouter NATIVE_MODE: its underlying is the chain's
   * wrapped native (WETH for ppETH), so deposits are funded with msg.value
   * through depositExactSharesNative and need no approval. Absent/false is the
   * audited ERC-20 mode and the only shape that existed before ppETH.
   */
  nativeMode?: boolean;
};

export type PreparedYieldTransaction = { to: Address; data: Hex; value: Hex };

export type PreparedYieldDeposit = {
  pendingNote: any;
  /** Ordered underlying approvals, including a zero reset when required. */
  approvalTxs: PreparedYieldTransaction[];
  /** Last approval, or null when the existing allowance already covers the cap. */
  approvalTx: PreparedYieldTransaction | null;
  /** PPRouter.depositExactShares(...) — submit after the approval confirms. */
  depositTx: PreparedYieldTransaction;
  sharesValue: bigint;
  underlyingNeeded: bigint;
  maxUnderlyingIn: bigint;
};

/** Mirror of the SDK's PreparedYieldWithdrawRelay: the typed relayer request plus what to persist. */
export interface PreparedYieldWithdrawRelay {
  /** Typed params for the relayer's relayWithdrawal (processorAddress = the PPRouter, minUnderlyingOut). */
  relayParams: unknown;
  changePendingNotes: PendingNote[];
  spentNotes: Note[];
  recipientShares: bigint;
  quotedUnderlyingOut: bigint;
  minUnderlyingOut: bigint;
}

/** Mirror of the SDK's PoolSession.yield namespace (present only when a
 * yieldDeployment was configured — see services/pool-session-service.ts). */
export interface PoolSessionYield {
  /** Which deployment this namespace serves (SDK with v2-monorepo #397; absent before). */
  deployment?: { ppUSDC: string; underlying: string; ppUSDCDecimals?: number };
  /**
   * Yield earned on this share position (v2-monorepo#431; absent on an older
   * SDK). `compute` reads the no-argument `exchangeRate()` and nothing else;
   * the feeds and pool events are handed in already fetched.
   */
  earned?: { compute: (input: YieldEarnedInput) => Promise<YieldEarned> };
  deposit: {
    sharesForUnderlying: (underlyingAmount: bigint) => Promise<bigint>;
    prepareYieldDeposit: (params: { value: bigint; maxUnderlyingIn?: bigint }) => Promise<PreparedYieldDeposit>;
  };
  withdraw: {
    prepareYieldWithdraw: (...args: any[]) => Promise<any>;
    prepareYieldWithdrawRelay: (params: {
      inputCommitments: Hash[];
      amount: bigint;
      amountOut: bigint;
      recipient: string;
      signedFeeCommitment: unknown;
      /**
       * Whether the recipient gas top-up was asked of the relayer for THIS quote.
       * The SDK pins only its presence in the signed routing, so it must agree
       * with the `extraGas` the quote was fetched with or the prepare throws.
       */
      extraGas?: boolean;
      slippageBps?: bigint;
    }) => Promise<PreparedYieldWithdrawRelay>;
  };
  token: any;
  router: any;
}

// Structural mirror of the SDK's TxReceipt (types/RPC.ts): `status` is the
// on-chain success flag — a resolved promise does NOT mean the transaction
// succeeded (the SDK deliberately returns failed receipts without persisting
// note updates), so callers MUST branch on `status === true`.
export type TxReceiptLike = {
  status: boolean;
  txHash: Hash;
  blockNumber?: Hex;
  logs?: unknown[];
};

// Structural mirror of the SDK's SetAuthPolicyTypedData
// (IPoolSessionKeystore.buildSetAuthPolicyTypedData). Handed straight to the
// wallet's signTypedData. The uint256 fields are `bigint` — the EIP-712-native
// representation viem/wagmi expect — and the struct field ORDER must stay
// (account, authDigest, nullifyingKeyHash, deadline) to match
// SET_AUTH_POLICY_TYPEHASH in Keystore.sol, or the signature will not verify.
export type SetAuthPolicyTypedDataLike = {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  types: Record<string, readonly { readonly name: string; readonly type: string }[]>;
  primaryType: string;
  message: {
    account: Address;
    authDigest: bigint;
    nullifyingKeyHash: bigint;
    deadline: bigint;
  };
};

// Structural mirror of the SDK's SwapStatusResult (LiFi delivery tracking).
export type SwapStatusLike = {
  status: 'NOT_FOUND' | 'PENDING' | 'DONE' | 'FAILED';
  substatus?: string;
  substatusMessage?: string;
  receiving?: { txHash?: Hash; chainId: number; txLink?: string };
  explorerLink?: string;
};

// Opaque interface types — only used for typing, never constructed from here.
export interface PoolSession {
  /** Aave-yield sessions; undefined unless a yieldDeployment was configured. */
  readonly yield?: PoolSessionYield;
  /** Every yield namespace (v2-monorepo #397); undefined on an older SDK. */
  readonly yields?: readonly PoolSessionYield[];
  /** The namespace serving a share or underlying address (v2-monorepo #397). */
  yieldFor?: (tokenAddress: string) => PoolSessionYield | undefined;
  /** Note manager pass-throughs (IPoolSessionNoteManager). */
  markNotesSpent: (params: { commitment: Hash; spentAtBlock: Hex }[]) => Promise<void>;
  addNotes: (params: { pendingNote: PendingNote; txHash: Hash }[]) => Promise<void>;
  // Result types come from the SDK (type-only, no runtime import). They were
  // `any`, which hid that the core-sdk split moved to/callData/msgValue into
  // depositTx / transactTx / ragequitTx: every submit path would have sent
  // `undefined` without a type error.
  prepareDeposit: (...args: any[]) => Promise<import("@privacy-pools-v2/sdk").PrepareDepositResult>;
  prepareDepositFor: (...args: any[]) => Promise<import("@privacy-pools-v2/sdk").PrepareDepositResult>;
  prepareWithdraw: (...args: any[]) => Promise<import("@privacy-pools-v2/sdk").PrepareWithdrawResult>;
  prepareTransfer: (...args: any[]) => Promise<import("@privacy-pools-v2/sdk").PrepareTransferResult>;
  prepareRageQuit: (...args: any[]) => Promise<import("@privacy-pools-v2/sdk").PrepareRageQuitResult>;
  prepareRegisterKeystore: (...args: any[]) => Promise<any>;
  registerKeystore: (...args: any[]) => Promise<any>;
  isKeystoreRegistered: (...args: any[]) => Promise<boolean>;
  relayWithdraw: (...args: any[]) => Promise<any>;
  relayTransfer: (...args: any[]) => Promise<any>;
  // Cold-start claim: gasless keystore registration bundled with the
  // withdrawal (config/cold-start.ts + services/cold-start-claim.ts).
  // buildSetAuthPolicyTypedData(deadline) returns the EIP-712 payload the
  // WALLET signs — the SDK never signs it — and registerAndWithdraw sends that
  // signature plus a proof anchored to the PREDICTED post-registration keystore
  // root to the relayer's register-and-withdrawal endpoint, which runs
  // Keystore.setAuthPolicyWithSig and the withdrawal in one transaction.
  buildSetAuthPolicyTypedData: (deadline: Hex) => SetAuthPolicyTypedDataLike;
  registerAndWithdraw: (...args: any[]) => Promise<TxReceiptLike>;
  // v2.0 full-balance batch withdrawal (see services/batch-withdrawals.ts).
  // prepareBatchWithdraw({ tokenId, recipientAddress }) → BatchPrepareResult +
  // relayerInfo/quote; relayBatchWithdraw(prepared) → TxReceipt, persisting
  // note updates only after a confirmed successful receipt.
  prepareBatchWithdraw: (...args: any[]) => Promise<Awaited<ReturnType<import("@privacy-pools-v2/sdk").EvmPoolSession["prepareBatchWithdraw"]>>>;
  relayBatchWithdraw: (...args: any[]) => Promise<any>;
  // v2.0 intent swaps (see services/intent-swaps.ts). prepareSwapQuote
  // orchestrates relayer fee quote + LiFi route + signed commitment (throws
  // unless a swapQuoteProvider was configured — pool-session-service wires
  // one only when EXPO_PUBLIC_INTENT_SWAPS is on); relayWithdrawAndSwap
  // proves + submits; getSwapStatus polls LiFi for delivery.
  prepareSwapQuote: (...args: any[]) => Promise<any>;
  relayWithdrawAndSwap: (...args: any[]) => Promise<TxReceiptLike>;
  getSwapStatus: (...args: any[]) => Promise<SwapStatusLike>;
  exportAccount: () => Promise<AccountExport>;
  importAccount: (data: AccountExport) => void | Promise<void>;
  generatePaymentRequest: (...args: any[]) => Promise<any>;
  prepareFulfillPaymentRequest: (...args: any[]) => Promise<import("@privacy-pools-v2/sdk").PrepareTransferResult>;
  fulfillPaymentRequest: (...args: any[]) => Promise<any>;
  discoverNotes: (...args: any[]) => Promise<any>;
}

export interface INoteManager {
  addNote: (note: Note, parentCommitmentHash?: Hash) => void;
  // The block is optional in the SDK but load-bearing for EXIT_PENDING: it is the
  // height settlement later reads back, so omitting it makes NoteManager fall back
  // to the sync cursor and settle against the wrong block.
  updateNoteStatus: (commitmentHash: Hash, status: NoteStatus, currentBlock?: Hex) => void;
  getNotes: (filters?: { status?: NoteStatus; label?: Hash; tokenId?: Address }) => Note[];
  getNote: (commitmentHash: Hash) => Note;
  exportState: () => AccountExport;
  // v2.0 migration: importState is async now (persists via the storage
  // adapter when overwrite is set); in-memory state is still rebuilt
  // synchronously, so existing un-awaited call sites stay correct.
  importState: (data: AccountExport) => void | Promise<void>;
}

export interface IKeystoreManager {
  getPrivateNullifyingKey: () => Secret;
  getPrivateRevocableKey: () => Secret;
  getViewingKeyPair: () => { privateKey: Secret; publicKey: Secret };
  // Revocable-key rotation: the SDK's KeystoreManager exposes the
  // current rotation index (0x-hex u64) and an applyRotation() to swap
  // in a freshly-derived key. ppv2 doesn't rotate (index stays 0), but
  // the mirror must match the SDK interface or PoolSessionConfig typing
  // rejects the manager.
  getRevocableKeyIndex: () => Hex;
  applyRotation: (newIndex: Hex, newKey: Secret) => void;
  isRegistered: (chainId: number) => boolean;
  markRegistered: (chainId: number) => void;
}

export type PrepareDepositResult = import("@privacy-pools-v2/sdk").PrepareDepositResult;
export type PrepareWithdrawResult = import("@privacy-pools-v2/sdk").PrepareWithdrawResult;
export type PrepareTransferResult = import("@privacy-pools-v2/sdk").PrepareTransferResult;
export type PrepareRageQuitResult = import("@privacy-pools-v2/sdk").PrepareRageQuitResult;
