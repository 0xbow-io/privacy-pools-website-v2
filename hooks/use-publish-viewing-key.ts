import { useCallback } from 'react';
import { useAccount, usePublicClient, useSendTransaction, useSwitchChain } from 'wagmi';
import type { Address as ViemAddress, Hex } from 'viem';

import { usePoolSession } from '@/hooks/use-pool-session';
import { useSessionChainId } from '@/hooks/use-session-chain-id';
import { useDebug } from '@/components/debug-provider';
import { isSupportedEvmChainId } from '@/config/chains';
import { isSessionInitTimeout, withSessionInitTimeout } from '@/services/session-init-timeout';
import { setReceiveSetup, viewingKeyTxPlan } from '@/services/receive-setup';
import { minPriorityFeeFor, readFeeMarket, type FeeReadClient } from '@/services/wallet-tx-fees';

export const PUBLISH_PROMPT_TIMEOUT_MS = 120_000;

/** RPC lag allowance right after a relay. */
const AUTH_LAG_RETRIES = 3;
const AUTH_LAG_RETRY_MS = 2_000;

export const PUBLISH_PROMPT_TIMEOUT_MESSAGE =
  'Your wallet did not answer. Open it and check for a pending request, then try again.';

/** Thrown before the wallet is prompted, so the caller can offer a top-up. */
export class ViewingKeyGasShortError extends Error {
  readonly needWei: bigint;
  readonly balanceWei: bigint;
  constructor(needWei: bigint, balanceWei: bigint) {
    super('This wallet does not have enough gas to publish its viewing key.');
    this.name = 'ViewingKeyGasShortError';
    this.needWei = needWei;
    this.balanceWei = balanceWei;
  }
}

export function isViewingKeyGasShort(err: unknown): err is ViewingKeyGasShortError {
  return err instanceof ViewingKeyGasShortError
    || (err instanceof Error && err.name === 'ViewingKeyGasShortError');
}

export type PublishViewingKeyResult =
  | { kind: 'published'; txHash: Hex }
  | { kind: 'already' };

/**
 * Sends `Keystore.setViewingKey` from the wallet (it is `msg.sender`-only, so no
 * relayer can). Session chain only.
 */
export function usePublishViewingKey(chainId: number) {
  const { address } = useAccount();
  const sessionChainId = useSessionChainId();
  const publicClient = usePublicClient({ chainId });
  const { sendTransactionAsync } = useSendTransaction();
  const { switchChainAsync } = useSwitchChain();
  const { ensureInitialized, identityMode, sessionAddress, poolSession } = usePoolSession();
  const { log } = useDebug();

  /**
   * `null` when a read fails; the wallet then decides. Otherwise `plan` is the
   * gas limit and fee caps the tx is sent with, so `costWei` is exactly what
   * the wallet reserves (DEV-554). Balance is read live on every call, so a
   * wallet funded after a refusal is seen on the next press.
   */
  const estimateCost = useCallback(async (calldata?: { to: string; data: string }) => {
    if (!publicClient || !address) return null;
    try {
      // Shared wallet fee policy (services/wallet-tx-fees.ts, DEV-542).
      const [market, balanceWei] = await Promise.all([
        readFeeMarket(publicClient as unknown as FeeReadClient, chainId),
        publicClient.getBalance({ address }),
      ]);
      const { gasPriceWei } = market;
      let gasEstimate: bigint | null = null;
      if (calldata) {
        try {
          gasEstimate = await publicClient.estimateGas({
            account: address,
            to: calldata.to as ViemAddress,
            data: calldata.data as Hex,
          });
        } catch {
          // Fails for an account short of gas; the static budget is used instead.
        }
      }
      const plan = viewingKeyTxPlan({ ...market, gasEstimate, minPriorityFeeWei: minPriorityFeeFor(chainId) });
      return {
        costWei: plan.costWei,
        balanceWei,
        // What the wallet reserves for the tx as sent; the shown estimate is this same figure.
        // No fee caps (block unread): the wallet prices the tx, so it decides.
        affordable: plan.fees === null ? true : balanceWei >= plan.costWei,
        plan,
      };
    } catch (err) {
      log('warn', 'PublishViewingKey', 'Gas / balance read failed', err);
      return null;
    }
  }, [publicClient, address, log, chainId]);

  const publishViewingKey = useCallback(async (options?: {
    onStatus?: (message: string) => void;
  }): Promise<PublishViewingKeyResult> => {
    const setStatus = options?.onStatus ?? (() => {});
    if (identityMode !== 'wallet' || !address) {
      throw new Error('Publishing a viewing key needs the owner wallet. Sign out of the account key and connect it.');
    }
    if (chainId !== sessionChainId) {
      throw new Error('Switch the app to this chain to finish setup there.');
    }
    // Checked before sending, so a sent tx is always confirmable.
    if (!publicClient) {
      throw new Error('Cannot confirm the transaction on this network (no RPC client). Check the connection and try again.');
    }
    if (isSupportedEvmChainId(chainId)) {
      await switchChainAsync({ chainId });
    }
    const session = await ensureInitialized();
    // A lagging RPC can still miss the auth policy right after a relay.
    let registration = await session.prepareRegisterKeystore();
    for (let attempt = 0; attempt < AUTH_LAG_RETRIES && registration.keystoreCalldata; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, AUTH_LAG_RETRY_MS));
      registration = await session.prepareRegisterKeystore();
    }
    if (registration.alreadyRegistered) {
      setReceiveSetup(sessionAddress ?? address, chainId, 'complete', 'onchain');
      return { kind: 'already' };
    }
    if (registration.keystoreCalldata || !registration.viewingKeyCalldata) {
      throw new Error('This account is not registered on this chain yet. Register first.');
    }
    const calldata = registration.viewingKeyCalldata;

    // Same for the balance: a stale zero would offer a second, needless relay.
    let cost = await estimateCost(calldata);
    for (let attempt = 0; attempt < AUTH_LAG_RETRIES && cost && !cost.affordable; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, AUTH_LAG_RETRY_MS));
      cost = await estimateCost(calldata);
    }
    if (cost && !cost.affordable) {
      log('warn', 'PublishViewingKey', 'Wallet is short of gas for setViewingKey', {
        chainId,
        costWei: cost.costWei.toString(),
        balanceWei: cost.balanceWei.toString(),
      });
      throw new ViewingKeyGasShortError(cost.costWei, cost.balanceWei);
    }

    // FlowProgress derives its stage from this text: no "prove"/"relay".
    setStatus('Confirm in your wallet to publish your viewing key');
    let hash: Hex;
    try {
      hash = await withSessionInitTimeout(
        sendTransactionAsync({
          chainId,
          to: calldata.to as ViemAddress,
          data: calldata.data as Hex,
          value: BigInt(calldata.value),
          // The checked numbers, not the wallet's own (often far higher) tier.
          ...(cost ? { gas: cost.plan.gas, ...(cost.plan.fees ?? {}) } : {}),
        } as Parameters<typeof sendTransactionAsync>[0]),
        { timeoutMs: PUBLISH_PROMPT_TIMEOUT_MS },
      );
    } catch (err) {
      if (isSessionInitTimeout(err)) throw new Error(PUBLISH_PROMPT_TIMEOUT_MESSAGE);
      throw err;
    }
    setStatus('Waiting for confirmation…');
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== 'success') {
      throw new Error(`Publishing the viewing key reverted onchain (tx ${hash}).`);
    }
    setReceiveSetup(sessionAddress ?? address, chainId, 'complete', 'onchain');
    log('info', 'PublishViewingKey', 'Viewing key published', { chainId, txHash: hash });
    return { kind: 'published', txHash: hash };
  }, [
    identityMode,
    address,
    chainId,
    sessionChainId,
    publicClient,
    switchChainAsync,
    ensureInitialized,
    sessionAddress,
    estimateCost,
    sendTransactionAsync,
    log,
  ]);

  /**
   * Display estimate for the tx Finish setup will actually send: priced on the
   * real `setViewingKey` calldata, so the amount shown is the amount checked
   * and sent. `null` (show nothing) without a live wallet session on this
   * chain or when there is no viewing-key leg to price; never prompts.
   */
  const estimatePublishCost = useCallback(async () => {
    if (identityMode !== 'wallet' || chainId !== sessionChainId || !poolSession) return null;
    try {
      const registration = await poolSession.prepareRegisterKeystore();
      if (registration.alreadyRegistered || registration.keystoreCalldata || !registration.viewingKeyCalldata) return null;
      return await estimateCost(registration.viewingKeyCalldata);
    } catch {
      return null;
    }
  }, [identityMode, chainId, sessionChainId, poolSession, estimateCost]);

  return { publishViewingKey, estimateCost, estimatePublishCost };
}
