/**
 * Ask the ASP whether 0xbow services (relayer, website) refuse the connected
 * wallet.
 *
 * The user starts it from the account menu. Naming the wallet is the point of
 * the request, the same as the self-report, so it carries its own egress intent
 * and is never run from a sync or on connect. The ASP only answers for a wallet
 * that signs its SIWE message, so nobody can probe someone else's address, and
 * it only says yes or no, never why.
 *
 * A denial is about 0xbow services only. Nothing on-chain changes: self-relay
 * and ragequit stay open.
 */
import type { NonceResponse, WalletScreeningCheckRequest, WalletScreeningCheckResponse } from '@/services/api-types';

export interface WalletScreeningDeps {
  getNonce: (address: string) => Promise<NonceResponse>;
  check: (body: WalletScreeningCheckRequest) => Promise<WalletScreeningCheckResponse>;
  /** Personal-sign the exact message the ASP generated. */
  signMessage: (message: string) => Promise<string>;
}

export async function checkWalletScreening(address: string, deps: WalletScreeningDeps): Promise<{ denied: boolean }> {
  const { nonce, message } = await deps.getNonce(address);
  // Signed verbatim: the ASP rebuilds the message from the nonce it stored and
  // refuses anything that differs.
  const signature = await deps.signMessage(message);
  const { denied } = await deps.check({ address, nonce, message, signature });
  if (typeof denied !== 'boolean') throw new Error('Unexpected screening response');
  return { denied };
}
