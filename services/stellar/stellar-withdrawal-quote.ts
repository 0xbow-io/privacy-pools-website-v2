import type { IRelayerInteractor, StellarAddress } from '@privacy-pools-v2/stellar-sdk';
import { STELLAR_TESTNET_CONTRACTS } from '@/config/stellar-deployment';
import { quoteMatchesSignedCommitment } from '@/services/relayer-quote-integrity';
import { isFreshCommitmentLive } from '@/services/intent-swaps';

/** The same committed quote is validated for Review and for the fresh pre-proof check. */
export async function stellarWithdrawalQuote(
  relayer: IRelayerInteractor<StellarAddress>,
  params: { amount: bigint; recipient: string; inputCount: number },
) {
  const asset = STELLAR_TESTNET_CONTRACTS.nativeAssetContractId;
  const [relayerInfo] = await relayer.getRelayers();
  if (!relayerInfo) throw new Error('The relayer did not return a quote.');
  const count = Math.min(params.inputCount, 5);
  const quote = await relayer.getWithdrawalQuote(relayerInfo, {
    asset, commit: true, recipient: params.recipient, extraGas: false,
    amount: params.amount.toString(), shape: { n: count, m: count },
  });
  const commitment = quote.feeCommitment;
  if (!commitment || !quoteMatchesSignedCommitment(quote)
    || commitment.asset !== asset || commitment.recipient !== params.recipient
    || BigInt(commitment.amountReceived) !== params.amount
    || BigInt(commitment.amountSent) !== params.amount + BigInt(commitment.feeAmount)) {
    throw new Error('The relayer quote does not match the requested withdrawal. Nothing was sent. Please try again.');
  }
  if (!isFreshCommitmentLive(commitment.expiration, Date.now())) {
    throw new Error('The relayer quote expired before it arrived. Please try again.');
  }
  return { relayerInfo, quote };
}
