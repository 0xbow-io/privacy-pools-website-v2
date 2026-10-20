/**
 * Sui keystore hooks — register auth policy and viewing key.
 */
import { useState, useCallback } from 'react';
import { Transaction } from '@mysten/sui/transactions';
import { useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit';
import { requireSuiTxSuccess } from '@/services/sui-witness/tx-confirm';
import { friendlyError } from '@/services/sui-witness/abort-codes';

/** Sui system Clock shared object (INTL-19 liveness-gated keystore roots). */
const SUI_CLOCK = '0x6';

export function useSuiKeystore() {
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const suiClient = useSuiClient();

  const setAuthPolicy = useCallback(async (params: {
    packageId: string;
    keystoreObjectId: string;
    authDigest: bigint;
    nullifyingKeyHash: bigint;
  }) => {
    try {
      setStatus('submitting');
      const tx = new Transaction();
      tx.moveCall({
        target: `${params.packageId}::keystore::set_auth_policy`,
        // Contract: set_auth_policy(keystore, auth_digest, nullifying_key_hash, &Clock, ctx)
        // The &Clock arg was added for INTL-19 (liveness-gated keystore roots).
        arguments: [
          tx.object(params.keystoreObjectId),
          tx.pure.u256(params.authDigest),
          tx.pure.u256(params.nullifyingKeyHash),
          tx.object(SUI_CLOCK),
        ],
      });
      const result = await signAndExecute({ transaction: tx });
      // Digest != success — Move aborts still resolve (codex round 3).
      await requireSuiTxSuccess(suiClient, result.digest, 'Keystore registration');
      setStatus('success');
      return result.digest;
    } catch (err) {
      setError(friendlyError(err));
      setStatus('error');
      // Rethrow (with the friendly message) instead of returning null: the
      // caller's E_AUTH_POLICY_ALREADY_SET tolerance and the spend paths' fail-
      // fast both need the real error. Swallowing it here meant a rejected
      // wallet prompt surfaced ~30s later as a generic "registration has not
      // appeared on-chain" from the leaf wait.
      throw new Error(friendlyError(err));
    }
  }, [signAndExecute, suiClient]);

  const setViewingKey = useCallback(async (params: {
    packageId: string;
    keystoreObjectId: string;
    viewingKey: bigint;
  }) => {
    try {
      setStatus('submitting');
      const tx = new Transaction();
      tx.moveCall({
        target: `${params.packageId}::keystore::set_viewing_key`,
        arguments: [
          tx.object(params.keystoreObjectId),
          tx.pure.u256(params.viewingKey),
        ],
      });
      const result = await signAndExecute({ transaction: tx });
      // Digest != success — Move aborts still resolve (codex round 3).
      await requireSuiTxSuccess(suiClient, result.digest, 'Keystore registration');
      setStatus('success');
      return result.digest;
    } catch (err) {
      setError(friendlyError(err));
      setStatus('error');
      return null;
    }
  }, [signAndExecute, suiClient]);

  return { status, error, setAuthPolicy, setViewingKey, reset: useCallback(() => {
    setStatus('idle'); setError(null);
  }, []) };
}
