// An SDK `IWalletInteractor` over the connected wagmi wallet, pinned to ONE
// chain.
//
// ppv2 normally hands the SDK no wallet at all: every flow calls a `prepare*`
// method and this app submits the calldata itself through wagmi (which is why
// swap-flows takes a `submit` callback). The exception is a cross-chain
// swap-and-deposit: the session's `swapDepositSourceChain` REQUIRES a wallet for
// the source chain in its type, because that is where the approval and the LiFi
// transaction execute while the deposit lands in the destination pool. In
// practice this app still submits both itself, so the object below is required
// by the shape rather than exercised — which is exactly why it must not lie
// about the chain it would act on.
//
// Every call is pinned to `chainId`: wagmi would otherwise submit on whatever
// chain the wallet happens to be on, which for this flow is precisely the
// distinction that matters.
import type { Address, Hex } from 'viem';

/** The SDK's PreparedTransaction (to/data/value), structurally. */
export interface PreparedTx {
  to: Address;
  data: Hex;
  value: Hex;
}

export interface Eip712Payload {
  domain: unknown;
  types: unknown;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface WagmiWalletInteractorDeps {
  /** The chain every call is pinned to — the source chain, not the wallet's current one. */
  chainId: number;
  /** Connected account. Reported by getAccounts, so the SDK's "first wallet" is this one. */
  address: Address;
  sendTransaction: (tx: { chainId: number; to: Address; data: Hex; value: bigint }) => Promise<Hex>;
  signTypedData: (payload: Eip712Payload) => Promise<Hex>;
}

/**
 * Build the interactor. Deliberately not a class: the SDK only needs these four
 * methods, and a plain object keeps the wagmi hooks at the call site where their
 * React identity is managed.
 */
export function createWagmiWalletInteractor(deps: WagmiWalletInteractorDeps) {
  const { chainId, address, sendTransaction, signTypedData } = deps;
  return {
    async sendTransaction(tx: PreparedTx): Promise<Hex> {
      return sendTransaction({
        chainId,
        to: tx.to,
        data: tx.data,
        // The SDK hands value as hex; wagmi wants a bigint. An empty/absent
        // value is zero, not NaN.
        value: tx.value ? BigInt(tx.value) : 0n,
      });
    },
    async signTypedData(typedData: Eip712Payload): Promise<Hex> {
      return signTypedData(typedData);
    },
    async getAccounts(): Promise<Address[]> {
      return [address];
    },
    async getChainId(): Promise<number> {
      // The chain this interactor ACTS ON, not the one the wallet happens to be
      // on. Nothing in ppv2's path reads it today: the SDK consults it only in
      // its BUILDER path (assertWalletMatchesAccountAndChain) and in
      // executeSwapAndDeposit, and this app uses the direct factory with its own
      // `submit` callback instead. Pinning it keeps the object honest for
      // whichever of those we adopt next — reporting the wallet's live chain
      // would defeat the very check that guards this flow.
      return chainId;
    },
  };
}
