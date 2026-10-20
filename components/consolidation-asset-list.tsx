import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { loadStoredAccountExport } from '@/components/sdk-provider';
import type { TransferPrefill } from '@/components/transfer-modal-provider';
import { useSeedDerivationModal } from '@/components/seed-derivation-modal-provider';
import { useChainRouter } from '@/hooks/use-chain-router';
import { usePoolSession } from '@/hooks/use-pool-session';
import { useSessionChainId } from '@/hooks/use-session-chain-id';
import { useNotes } from '@/hooks/use-notes';
import { useTransferFeeEstimate } from '@/hooks/use-transfer-fee-estimate';
import { useConsolidationStart } from '@/hooks/use-consolidation-start';
import { getChainConfig, supportedEvmChainIds } from '@/config/chains';
import { getKnownTokenMetadata, type TokenMetadata } from '@/config/tokens';
import { bestConsolidation, consolidationGroups, type ConsolidatableNote } from '@/services/consolidate-notes';
import { displayTokenSymbol } from '@/services/share-display';
import type { Note } from '@/services/sdk-types';

type AssetRow = { chainId: number; token: TokenMetadata; owned: ConsolidatableNote[]; noteCount: number; depositCount: number };
const chainName = (chainId: number) => getChainConfig(chainId)?.displayName ?? 'this network';

/**
 * The owner's notes on `chainId`: the live notes on the active network, the
 * stored account export on any other. Neither read makes a request.
 */
export function consolidatableNotesOn(chainId: number, activeChainId: number, activeNotes: readonly Note[], owner: string): ConsolidatableNote[] {
  const chainNotes = chainId === activeChainId ? activeNotes : loadStoredAccountExport(owner, chainId)?.notes ?? [];
  return chainNotes.filter((note) => note.isOwned && String(note.ownerAddress ?? '').toLowerCase() === owner.toLowerCase())
    .map((n) => ({ commitment: String(n.commitment), label: n.label ? String(n.label) : null, tokenId: n.tokenId ? String(n.tokenId) : null, value: String(n.value), status: String(n.status) }));
}

/**
 * The consolidation modal's first step, across every EVM network. The active
 * network's notes are live; the others are read from their stored account
 * exports. Neither read, nor any fee estimate, makes a request. Picking another
 * network switches to it and continues once that network's session has loaded.
 */
export function ConsolidationAssetList({ onStart, onClose }: {
  /** Opens the note picker on the active network. */
  onStart: (prefill: TransferPrefill) => void;
  onClose: () => void;
}) {
  const { activeChainId, isSui, isStellar } = useChainRouter();
  const sessionChainId = useSessionChainId();
  const { keysReady, sessionAddress, isInitializing, isInitialized, error } = usePoolSession();
  const { notes, isLoading } = useNotes();
  const { openSeedDerivationModal } = useSeedDerivationModal();
  const { pending, start: startOn } = useConsolidationStart(onStart);
  // A declined network switch shows the list instead of prompting again.
  const [skipped, setSkipped] = useState(false);
  const supported = !isSui && !isStellar;
  const ready = supported && keysReady && sessionChainId === activeChainId && isInitialized;
  const rows = useMemo<AssetRow[]>(() => {
    if (!ready || !sessionAddress) return [];
    return [activeChainId, ...supportedEvmChainIds.filter((id) => id !== activeChainId)].flatMap((chainId) => {
      const owned = consolidatableNotesOn(chainId, activeChainId, notes, sessionAddress);
      const groups = consolidationGroups(owned);
      return [...new Set(groups.map((group) => group.tokenId))].flatMap((tokenId) => {
        const token = getKnownTokenMetadata(tokenId, chainId);
        const tokenGroups = groups.filter((group) => group.tokenId === tokenId);
        return token ? [{ chainId, token, owned, depositCount: tokenGroups.length,
          noteCount: tokenGroups.reduce((sum, group) => sum + group.notes.length, 0) }] : [];
      });
    });
  }, [ready, sessionAddress, activeChainId, notes]);

  const start = useCallback(async (chainId: number, prefill: TransferPrefill) => {
    if (await startOn(chainId, prefill) === 'declined') setSkipped(true);
  }, [startOn]);
  // One asset to choose from: go straight to its note picker, with no list to
  // go back to. Before paint, so the list never shows. The same fee check as
  // its row: notes that cannot cover the fee stay on the list, which says why.
  // Decided once the fee is known, so a later fee change never opens the picker
  // over a list being read.
  const only = !skipped && !pending && rows.length === 1 ? rows[0] : null;
  const onlyFeeFor = useTransferFeeEstimate(only?.chainId ?? activeChainId);
  const onlyDecided = useRef(false);
  useLayoutEffect(() => {
    if (!only || !sessionAddress || onlyDecided.current) return;
    const fee = onlyFeeFor(only.token.address);
    if (fee === null) return;
    onlyDecided.current = true;
    const pick = bestConsolidation(only.owned, only.token.address, fee);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot handoff to the note picker
    if (pick) void start(only.chainId, { recipient: sessionAddress, tokenSymbol: only.token.symbol, inputCommitments: pick.notes.map((note) => note.commitment) });
  }, [only, sessionAddress, start, onlyFeeFor]);

  const loading = supported && keysReady && !error && (isLoading || isInitializing || !isInitialized || sessionChainId !== activeChainId);
  return (
    <View className="w-full gap-[16px] shrink" testID="consolidation-entry">
      <Text className="font-pp-bold text-[22px] leading-[28px] text-text pr-[30px]">Consolidate notes</Text>
      {ready && !loading && !error && !pending && rows.length > 0 && (
        <Text className="font-pp-regular text-[13px] leading-[19px] text-text-secondary">
          Choose an asset to combine its notes in your private balance.
        </Text>
      )}
      {!supported ? (
        <Text className="font-pp-regular text-[14px] text-text-secondary">Note consolidation is available on EVM networks. Choose an EVM network from the network menu.</Text>
      ) : !keysReady ? (
        <>
          <Text className="font-pp-regular text-[14px] text-text-secondary">Unlock your private account to check which notes can be consolidated.</Text>
          <Pressable accessibilityRole="button" onPress={() => openSeedDerivationModal({ onSigned: () => {} })}
            className="h-[46px] rounded-control bg-button-primary items-center justify-center">
            <Text className="font-pp-medium text-[14px] text-button-primary-text">Unlock private account</Text>
          </Pressable>
        </>
      ) : error ? (
        <Text accessibilityRole="alert" className="font-pp-regular text-[14px] text-warning">Your private account could not be loaded. Check your connection and try again.</Text>
      ) : pending ? (
        <Text className="font-pp-regular text-[14px] text-text-secondary">
          Switching to {chainName(pending.chainId)} and loading your notes there. Approve the network switch in your wallet if asked.
        </Text>
      ) : loading ? (
        <Text className="font-pp-regular text-[14px] text-text-secondary">Loading your private notes…</Text>
      ) : rows.length === 0 ? (
        <View className="gap-[8px] py-[8px]" testID="consolidation-empty">
          <Text className="font-pp-medium text-[16px] leading-[22px] text-text">No notes to consolidate</Text>
          <Text className="font-pp-regular text-[13px] leading-[19px] text-text-secondary">
            You need at least two notes from the same original deposit. You can consolidate up to five notes across two groups of the same asset, with one group covering the relayer fee.
          </Text>
        </View>
      ) : (
        <ScrollView className="max-h-[320px] shrink" contentContainerClassName="gap-[10px]">
          {supportedEvmChainIds.map((chainId) => {
            const chainRows = rows.filter((row) => row.chainId === chainId);
            return chainRows.length > 0 && sessionAddress
              ? <ChainAssetRows key={chainId} chainId={chainId} rows={chainRows} recipient={sessionAddress}
                // Back only when there is a list to go back to.
                onStart={(chainId, prefill) => start(chainId, { ...prefill, fromAssetList: rows.length > 1 })} />
              : null;
          })}
        </ScrollView>
      )}
      <Pressable accessibilityRole="button" onPress={onClose} className="self-start h-[46px] px-[18px] rounded-control border border-border items-center justify-center">
        <Text className="font-pp-medium text-[14px] text-text">Close</Text>
      </Pressable>
    </View>
  );
}

/** One network's assets, checked against that network's cached fee estimate. */
function ChainAssetRows({ chainId, rows, recipient, onStart }: {
  chainId: number; rows: AssetRow[]; recipient: string; onStart: (chainId: number, prefill: TransferPrefill) => void;
}) {
  const feeFor = useTransferFeeEstimate(chainId);
  return rows.map(({ token, owned, noteCount, depositCount }) => {
    const fee = feeFor(token.address);
    const pick = bestConsolidation(owned, token.address, fee);
    return (
      <Pressable key={`${chainId}:${token.address}`} accessibilityRole="button" disabled={!pick}
        accessibilityLabel={`Consolidate ${displayTokenSymbol(token.symbol)} notes on ${chainName(chainId)}`}
        testID={`consolidation-asset-${chainId}-${token.address.toLowerCase()}`}
        onPress={() => {
          if (pick) onStart(chainId, { recipient, tokenSymbol: token.symbol, inputCommitments: pick.notes.map((note) => note.commitment) });
        }}
        className={`rounded-control border border-border-light bg-background-secondary p-[14px] gap-[6px] ${pick ? '' : 'opacity-50'}`}>
        <Text className="font-pp-medium text-[14px] text-text">{displayTokenSymbol(token.symbol)} on {chainName(chainId)}</Text>
        <Text className="font-pp-regular text-[12px] text-text-secondary">
          {noteCount} notes from {depositCount === 1 ? 'one deposit' : `${depositCount} separate deposits`} can be combined
        </Text>
        {!pick && (
          <Text className="font-pp-regular text-[12px] text-text-secondary">
            {fee === null ? 'Waiting for relayer fee information.' : 'These notes do not currently cover the relayer fee.'}
          </Text>
        )}
      </Pressable>
    );
  });
}
