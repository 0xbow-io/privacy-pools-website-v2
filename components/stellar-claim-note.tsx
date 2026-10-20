/**
 * /import-note page for a Stellar one-time claim link (services/stellar/stellar-claim.ts).
 *
 * Claim imports the link's notes into the connected Freighter account (local:
 * the SDK re-derives every field and refuses another owner's note). The fixed
 * sync clock then marks them spendable. "Save to my account" makes it
 * permanent: one private transfer to itself, announced to its own viewing
 * key, so any device finds it and the link is no longer needed. Freighter pays
 * for that and for registering the account first (relayed registration is not
 * available on Stellar).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ExplorerPrivacyHint } from '@/components/ui/explorer-privacy-hint';
import { useRouter } from 'expo-router';
import { Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { formatUnits } from 'viem';

import { useStellarWallet } from '@/components/stellar-wallet-provider';
import { STELLAR_TESTNET_ID, getExplorerTxUrl } from '@/config/chains';
import { STELLAR_XLM } from '@/config/stellar-deployment';
import { useChainRouter } from '@/hooks/use-chain-router';
import { useStellarSession } from '@/hooks/use-stellar-session';
import { useTabCloseGuard } from '@/hooks/use-tab-close-guard';
import { decodeStellarClaim, stellarClaimTotal } from '@/services/stellar/stellar-claim';
import { describeStellarStage, stellarErrorMessage } from '@/services/stellar/stellar-copy';

function short(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 6)}…${value.slice(-6)}`;
}

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return /reject|denied|cancel|declined/i.test(raw) ? 'Cancelled in Freighter.' : stellarErrorMessage(raw);
}

export function StellarClaimNoteScreen({ encoded }: { encoded: string }) {
  const { selectChain, activeChainId } = useChainRouter();
  const wallet = useStellarWallet();
  const stellar = useStellarSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keptTx, setKeptTx] = useState<string | null>(null);
  const router = useRouter();
  // A result belongs to one link and one account.
  useEffect(() => { setKeptTx(null); setError(null); }, [encoded, wallet.address]);

  const decoded = useMemo(() => {
    try {
      return { claim: decodeStellarClaim(encoded), error: null as string | null };
    } catch (e) {
      return { claim: null, error: e instanceof Error ? e.message : 'This claim link is not valid.' };
    }
  }, [encoded]);
  const claim = decoded.claim;
  const owner = claim?.notes[0]?.ownerAddress ?? null;
  const amountLabel = claim ? `${formatUnits(stellarClaimTotal(claim), STELLAR_XLM.decimals)} XLM` : null;
  const isOwner = !!owner && wallet.isConnected && wallet.address === owner;

  // This account's copies of the link's notes, as the session holds them.
  const held = useMemo(() => {
    if (!claim || !isOwner) return [];
    const wanted = new Set(claim.notes.map((n) => BigInt(n.commitment)));
    return stellar.notes.filter((n) => wanted.has(BigInt(n.commitment)));
  }, [claim, isOwner, stellar.notes]);
  const allHeld = !!claim && held.length === claim.notes.length;
  const spendable = allHeld && held.every((n) => n.status === 'ACTIVE');
  const used = held.some((n) => n.status === 'SPENT' || n.status === 'EXITED' || n.status === 'EXIT_PENDING');

  // Until it is saved to the account, the claimed note lives in this tab only.
  useTabCloseGuard(allHeld && !keptTx && !used, 'Only in this tab until you save it. The link restores it.');

  const ensureReady = async (): Promise<boolean> => {
    if (activeChainId !== STELLAR_TESTNET_ID) {
      const outcome = await selectChain(STELLAR_TESTNET_ID);
      if (outcome !== 'committed') { setError('Could not switch to Stellar Testnet.'); return false; }
    }
    if (!wallet.isConnected) {
      const connected = await wallet.connect();
      if (!connected) { setError(wallet.isAvailable ? 'Connect Freighter to claim.' : 'Install Freighter to claim.'); return false; }
    }
    return true;
  };

  const onClaim = async () => {
    if (!claim) return;
    setError(null);
    if (!(await ensureReady())) return;
    setBusy(describeStellarStage('unlocking'));
    try {
      await stellar.claim(claim.notes);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const onKeep = async () => {
    if (!claim) return;
    setError(null);
    setBusy(describeStellarStage('proving'));
    try {
      const { txHash } = await stellar.keepClaim(claim.notes.map((n) => n.commitment as `0x${string}`), {
        onStage: (stage) => setBusy(describeStellarStage(stage)),
      });
      setKeptTx(txHash);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  let body: React.ReactNode;
  if (!claim || !amountLabel || !owner) {
    body = (
      <View className="gap-[6px]">
        <Text className="font-pp-bold text-[16px] text-text">Invalid claim link</Text>
        <Text className="font-pp-regular text-[13px] text-text-secondary">{decoded.error}</Text>
      </View>
    );
  } else {
    body = (
      <>
        <View className="items-center gap-[4px]">
          <Text className="font-pp-regular text-[24px] text-text">{amountLabel}</Text>
          <Text className="font-pp-regular text-[13px] text-text-secondary">sent privately to {short(owner)}</Text>
        </View>
        {keptTx ? (
          <View className="items-center gap-[8px]">
            <Text className="font-pp-bold text-[15px] text-success">Saved to your account ✓</Text>
            <View className="flex-row items-center gap-[6px]">
<Pressable onPress={() => Linking.openURL(getExplorerTxUrl(STELLAR_TESTNET_ID, keptTx))} accessibilityRole="link" hitSlop={8}>
              <Text className="font-pp-medium text-[12px] text-primary underline">View on explorer</Text>
            </Pressable>
              <ExplorerPrivacyHint explorerName={'StellarExpert'} />
            </View>
          </View>
        ) : used ? (
          <Text className="text-center font-pp-regular text-[13px] text-text-secondary">This payment was already used from your account.</Text>
        ) : wallet.isConnected && !isOwner ? (
          <Text className="text-center font-pp-regular text-[13px] text-warning">
            This link is for {short(owner)}. Switch to that account in Freighter.
          </Text>
        ) : allHeld ? (
          <View className="gap-[10px]">
            <Text className="text-center font-pp-regular text-[13px] leading-[19px] text-text-secondary">
              {spendable
                ? 'Claimed. Save it to your account so it shows on any device. Until then keep this link.'
                : 'Claimed. It turns spendable after the next sync. Keep this link until you save it.'}
            </Text>
            <Pressable
              disabled={!spendable || !!busy}
              onPress={() => { void onKeep(); }}
              accessibilityRole="button"
              testID="stellar-claim-keep"
              className={`items-center justify-center bg-button-primary py-[14px] ${!spendable || busy ? 'opacity-50' : ''}`}
            >
              <Text className="font-pp-semi-bold text-[15px] text-button-primary-text">{busy ?? 'Save to my account'}</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            disabled={!!busy}
            onPress={() => { void onClaim(); }}
            accessibilityRole="button"
            testID="stellar-claim"
            className={`items-center justify-center bg-button-primary py-[14px] ${busy ? 'opacity-50' : ''}`}
          >
            <Text className="font-pp-semi-bold text-[15px] text-button-primary-text">{busy ?? 'Claim'}</Text>
          </Pressable>
        )}
        {error ? <Text className="font-pp-regular text-[12px] text-[#E11D48]">{error}</Text> : null}
      </>
    );
  }

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="items-center gap-[16px] px-[24px] py-[32px]">
      <Text className="font-pp-medium text-[11px] tracking-[2px] text-text-muted">PRIVACY POOLS V2</Text>
      <Text className="font-pp-bold text-[20px] text-center text-text">Claim Payment</Text>
      <Text className="font-pp-regular text-[12px] text-center text-text-secondary">Private payment on Stellar testnet</Text>
      <View className="w-full max-w-[560px] gap-[18px] border border-border-light bg-card-background px-[24px] py-[24px]">
        {body}
      </View>
      {/* No app chrome on this page at desktop widths: the way back. */}
      <Pressable onPress={() => router.replace('/?panel=balances' as never)} accessibilityRole="link" hitSlop={8} testID="stellar-claim-back">
        <Text className="font-pp-medium text-[13px] text-primary underline">Back to Privacy Pools</Text>
      </Pressable>
    </ScrollView>
  );
}
