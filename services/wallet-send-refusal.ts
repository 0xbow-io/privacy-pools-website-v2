// The wallet's own reason for refusing a send, kept through viem's retry
// (QA on DEV-589).
//
// viem sends `eth_sendTransaction`. When the wallet refuses it with an
// "invalid input" class error (-32000: underpriced, insufficient funds, a node
// it cannot reach), viem retries the same request as `wallet_sendTransaction`.
// A wallet answering that retry with -32601 gets the FIRST error thrown back,
// so the reason survives. One answering 4200 (EIP-1193 "unsupported method")
// gets the 4200 thrown instead, and the reason is gone from the whole chain:
// every refusal read "Your wallet could not send the transaction".
//
// This keeps the `eth_sendTransaction` refusal and throws it when the retry was
// only "unsupported", the way viem already does for -32601. Nothing extra is
// sent: same client, same requests, the error is only remembered.
import type { Client } from 'viem';
import { sendTransaction } from 'viem/actions';
import type { Config } from 'wagmi';
import { getConnectorClient } from 'wagmi/actions';
import { isUnsupportedMethod } from '@/services/wallet-batch';

type SendArgs = Parameters<typeof sendTransaction>[1];

/**
 * viem's sendTransaction on `client`, rethrowing the wallet's refusal of
 * `eth_sendTransaction` when the `wallet_sendTransaction` retry only answered
 * "unsupported method". Any other failure is thrown as viem threw it.
 */
export async function sendTransactionKeepingRefusal(client: Client, args: SendArgs): Promise<`0x${string}`> {
  let refusal: unknown = null;
  const recording = {
    ...client,
    request: (async (request: { method: string }, options?: unknown) => {
      try {
        return await (client.request as (r: unknown, o?: unknown) => Promise<unknown>)(request, options);
      } catch (err) {
        if (request.method === 'eth_sendTransaction') refusal = err;
        throw err;
      }
    }) as Client['request'],
  } as Client;
  try {
    return await sendTransaction(recording, args);
  } catch (err) {
    if (refusal && isUnsupportedMethod(err) && !isUnsupportedMethod(refusal)) throw refusal;
    throw err;
  }
}

/**
 * wagmi's `sendTransaction` (connector client, chain, `assertChainId`), sent
 * through `sendTransactionKeepingRefusal`.
 */
export async function sendWalletTransaction(
  config: Config,
  args: Omit<SendArgs, 'chain' | 'account'> & { account: `0x${string}`; chainId: number },
): Promise<`0x${string}`> {
  const { chainId, account, ...rest } = args;
  const client = await getConnectorClient(config, { account, chainId, assertChainId: false });
  const chain = client.chain?.id === chainId ? client.chain : ({ id: chainId } as Client['chain']);
  return sendTransactionKeepingRefusal(client, {
    ...rest,
    account,
    chain,
    assertChainId: true,
  } as SendArgs);
}
