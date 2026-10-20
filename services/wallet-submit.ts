import type { Hex } from '@/services/sdk-types';
import type { SubmittedTx } from '@/services/swap-flows';

/** Report a wallet's hash before receipt waiting (or UI updates) can fail. */
export async function submitWalletTransaction(
  send: () => Promise<Hex>,
  wait: (hash: Hex) => Promise<{ status: string }>,
  onBroadcast?: (hash: Hex) => void,
): Promise<SubmittedTx> {
  const hash = await send();
  onBroadcast?.(hash);
  const receipt = await wait(hash);
  return { txHash: hash, success: receipt.status === 'success' };
}
