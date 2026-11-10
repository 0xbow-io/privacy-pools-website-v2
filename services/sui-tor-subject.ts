import { bcs } from '@mysten/sui/bcs';
import { fromBase64 } from '@mysten/sui/utils';
import type { TorSubject } from '@/services/tor-groups';

/** What a Sui JSON-RPC body is about: its transaction's signer, or the transaction it looks up. */
export function suiSubject(_url: string, body: string): TorSubject {
  let call: { method?: unknown; params?: unknown[] };
  try {
    call = JSON.parse(body) as typeof call;
  } catch {
    return {};
  }
  const [first] = Array.isArray(call.params) ? call.params : [];
  if (typeof first !== 'string') return {};
  switch (call.method) {
    case 'sui_executeTransactionBlock':
    case 'sui_dryRunTransactionBlock':
      try {
        return { account: bcs.TransactionData.parse(fromBase64(first)).V1.sender };
      } catch {
        return { identifying: true };
      }
    case 'sui_getTransactionBlock':
      return { transaction: first };
    default:
      return {};
  }
}
