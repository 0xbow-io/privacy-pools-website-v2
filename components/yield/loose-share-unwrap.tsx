import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useAccount, useConfig, usePublicClient, useSendTransaction } from 'wagmi';
import { getAccount } from '@wagmi/core';
import { encodeFunctionData, erc20Abi, type Hex } from 'viem';
import { usePools } from '@/components/pools-provider';
import { useToast } from '@/components/toast-provider';
import { useTxActivity } from '@/components/tx-activity-provider';
import { getPinnedYieldDeployments } from '@/config/yield';
import { useActiveEvmChain } from '@/hooks/use-active-evm-chain';
import { detectLooseShares, formatShareAmount, needsApproval, planUnwrap, shareSymbol, unwrapTargetSymbol, type LooseShare } from '@/services/loose-share-unwrap';
import { priceWalletTx, walletTxFields } from '@/services/wallet-tx-fees';

/** Reads only the app-wide wallet poll. Opening Portfolio causes no requests. */
export function LooseShareUnwrap() {
  const { address, chainId, isConnected } = useAccount();
  const activeChain = useActiveEvmChain();
  const { walletShareBalances } = usePools();
  if (!isConnected || !address || chainId !== activeChain.id || !walletShareBalances
    || walletShareBalances.chainId !== chainId
    || walletShareBalances.owner.toLowerCase() !== address.toLowerCase()) return null;
  const shares = detectLooseShares(getPinnedYieldDeployments(chainId), walletShareBalances.balances);
  if (shares.length === 0) return null;
  return (
    <View className="gap-[8px]">
      {shares.map((share) => (
        <UnwrapRow key={`${chainId}:${address}:${share.deployment.ppUSDC}`} share={share}
          chainId={chainId} owner={address} allowance={walletShareBalances.allowances[share.deployment.ppUSDC.toLowerCase()]} />
      ))}
    </View>
  );
}

function UnwrapRow({ share: { deployment, shares }, chainId, owner, allowance }: {
  share: LooseShare; chainId: number; owner: `0x${string}`; allowance?: bigint;
}) {
  const config = useConfig();
  const publicClient = usePublicClient({ chainId });
  const { sendTransactionAsync } = useSendTransaction();
  const { beginTx, endTx, txPending } = useTxActivity();
  const { toast } = useToast();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const symbol = shareSymbol(deployment);
  const target = unwrapTargetSymbol(deployment);

  async function unwrap() {
    if (running.current || txPending || !publicClient || (deployment.zap && allowance === undefined)) return;
    running.current = true;
    setBusy(true);
    beginTx();
    const live = () => {
      const account = getAccount(config);
      if (!mounted.current || account.address?.toLowerCase() !== owner.toLowerCase() || account.chainId !== chainId) {
        throw new Error('Wallet changed. Try again with the original wallet and network.');
      }
    };
    const update = (message: string) => { if (mounted.current) setStatus(message); };
    const send = async (to: `0x${string}`, data: Hex, label: string) => {
      live();
      const tx = { account: owner, to, data, value: 0n };
      const fees = await priceWalletTx(publicClient!, tx, undefined, chainId);
      live();
      update(`Confirm ${label} in your wallet`);
      const hash = await sendTransactionAsync({ ...tx, chainId, ...walletTxFields(fees) });
      update(`Waiting for ${label} confirmation`);
      // This is our own wallet broadcast, never a relayed transaction hash.
      const receipt = await publicClient!.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (receipt.status !== 'success') throw new Error(`${label} reverted. Your shares were not unwrapped.`);
    };
    try {
      live();
      const plan = planUnwrap(deployment, shares, owner);
      if (needsApproval(plan, allowance ?? 0n) && plan.spender) {
        await send(deployment.ppUSDC, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [plan.spender, shares] }), 'approval');
      }
      const data = plan.kind === 'zap' ? encodeFunctionData(plan.call) : encodeFunctionData(plan.call);
      await send(plan.call.address, data, 'unwrap');
      update(`Unwrapped to ${target}`);
      toast({ title: `Unwrapped to ${target}` });
      // Balances update on their usual cadence, with no invalidation/refetch.
    } catch (error) {
      update(error instanceof Error ? error.message : 'Could not unwrap. Try again.');
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
      endTx();
    }
  }

  const disabled = busy || txPending || !publicClient || (!!deployment.zap && allowance === undefined);
  return (
    <View className="gap-[8px] rounded-card border border-border-light px-[16px] py-[12px]">
      <View className="flex-row flex-wrap items-center justify-between gap-[12px]">
        <Text className="font-pp-regular text-[14px] text-text-primary">
          You have {formatShareAmount(shares, deployment.ppUSDCDecimals)} {symbol} in your wallet
        </Text>
        <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled}
          className={`rounded-control bg-button-primary px-[16px] py-[8px] ${disabled ? 'opacity-50' : ''}`}
          onPress={() => void unwrap()}>
          <Text className="font-pp-medium text-[13px] text-button-primary-text">{busy ? 'Unwrapping...' : `Unwrap to ${target}`}</Text>
        </Pressable>
      </View>
      {status !== '' && <Text accessibilityLiveRegion="polite" className="font-pp-regular text-[13px] text-text-secondary">{status}</Text>}
    </View>
  );
}
