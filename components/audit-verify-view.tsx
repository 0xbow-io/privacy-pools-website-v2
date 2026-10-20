import React, { useCallback, useEffect, useState } from 'react';
import { ExplorerPrivacyHint } from '@/components/ui/explorer-privacy-hint';
import { Linking, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { formatUnits } from 'viem';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '@/components/theme-provider';
import { Colors } from '@/constants/theme';
import { getChainConfig, getExplorerName, getExplorerTxUrl } from '@/config/chains';
import { formatTokenBalance, getTokenMetadata } from '@/config/tokens';
import {
  decodePartialViewingKey,
  decodePartialViewingKeyBatch,
  isBatchEncoded,
  verifyPartialViewingKey,
  decodeOriginProof,
  isOriginEncoded,
  verifyOriginProof,
  type PartialViewingKeyV1,
  type VerifyResult,
  type OriginProofV1,
  type OriginVerifyResult,
} from '@/services/audit-receipt';
import { isShareSymbol, tokenAmountLabel } from '@/services/share-display';
import { useShareRateBook, type ShareRateBook } from '@/hooks/use-share-rates';
import { shareRateKey } from '@/services/share-rates';
import { shareConversionAt, shareValueLabel, type TxPosition } from '@/services/share-rate-history';

type BatchEntry = { bundle: PartialViewingKeyV1; result: VerifyResult };
type OriginEntry = { proof: OriginProofV1; result: OriginVerifyResult };

type Phase = 'idle' | 'verifying' | 'done';

function amountText(
  book: ShareRateBook | null,
  chainId: number,
  tokenId: string,
  valueWei: bigint,
  at: TxPosition | null,
): string {
  const token = getTokenMetadata(tokenId, chainId);
  if (!isShareSymbol(token.symbol)) return tokenAmountLabel(formatUnits(valueWei, token.decimals), token.symbol);
  const series = book?.get(shareRateKey(chainId, tokenId));
  const conv = series ? shareConversionAt(series, at) : null;
  if (conv) return shareValueLabel(conv, valueWei);
  return tokenAmountLabel(formatTokenBalance(Number(formatUnits(valueWei, token.decimals)), token.symbol), token.symbol);
}

export function AuditVerifyView({ initialEncoded }: { initialEncoded?: string }) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];

  const [input, setInput] = useState(initialEncoded ?? '');
  const [phase, setPhase] = useState<Phase>('idle');
  const [bundle, setBundle] = useState<PartialViewingKeyV1 | null>(null);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [batch, setBatch] = useState<BatchEntry[] | null>(null);
  const [origin, setOrigin] = useState<OriginEntry | null>(null);
  const rateBook = useShareRateBook();

  const reset = () => { setBundle(null); setResult(null); setBatch(null); setOrigin(null); };

  const run = useCallback(async (raw: string) => {
    // Proof of origin: a public withdrawal/exit linked to a note the prover
    // controls in that tx's lineage (not a proof of original deposit-ship).
    if (isOriginEncoded(raw)) {
      const decoded = decodeOriginProof(raw);
      if (!decoded) {
        reset();
        setDecodeError('This is not a valid proof of origin. Ask the sender to copy the whole link again.');
        setPhase('done');
        return;
      }
      reset(); setDecodeError(null); setPhase('verifying');
      const res = await verifyOriginProof(decoded);
      setOrigin({ proof: decoded, result: res });
      setPhase('done');
      return;
    }

    // Batch bundle (accounting export): verify each entry, show a list.
    if (isBatchEncoded(raw)) {
      const decoded = decodePartialViewingKeyBatch(raw);
      if (!decoded) {
        setBundle(null); setResult(null); setBatch(null); setOrigin(null);
        setDecodeError('This is not a valid viewing-key bundle. Ask the sender to copy the whole link again.');
        setPhase('done');
        return;
      }
      setDecodeError(null); setBundle(null); setResult(null); setBatch(null); setOrigin(null);
      setPhase('verifying');
      const results = await Promise.all(
        decoded.map(async (b) => ({ bundle: b, result: await verifyPartialViewingKey(b) })),
      );
      setBatch(results);
      setPhase('done');
      return;
    }

    const decoded = decodePartialViewingKey(raw);
    if (!decoded) {
      setBundle(null);
      setResult(null);
      setBatch(null);
      setOrigin(null);
      setDecodeError('This is not a valid partial viewing key. Ask the sender to copy it again.');
      setPhase('done');
      return;
    }
    setDecodeError(null);
    setBatch(null);
    setOrigin(null);
    setBundle(decoded);
    setResult(null);
    setPhase('verifying');
    const res = await verifyPartialViewingKey(decoded);
    setResult(res);
    setPhase('done');
  }, []);

  // Auto-verify when arriving from a link.
  useEffect(() => {
    if (initialEncoded) void run(initialEncoded);
  }, [initialEncoded, run]);

  const amountLabel = bundle
    ? amountText(rateBook, bundle.chainId, bundle.tokenId, BigInt(bundle.value), { timestampSec: result?.onChainTimestampSec })
    : null;
  const chainName = bundle ? getChainConfig(bundle.chainId)?.displayName ?? `Chain ${bundle.chainId}` : null;
  const dateLabel = result?.onChainTimestampSec
    ? new Date(result.onChainTimestampSec * 1000).toLocaleString()
    : null;

  const verified = result?.verified === true;

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="items-center gap-[12px] px-[24px] py-[32px]"
    >
      <Text className="font-pp-medium text-[11px] tracking-[2px] text-text-muted">PRIVACY POOLS V2</Text>
      <Text className="text-center font-pp-bold text-[20px] text-text">Verify a payment</Text>
      <Text className="max-w-[460px] text-center font-pp-regular text-[12px] text-text-secondary">
        Confirm the amount, token and recipient of a single transaction onchain.{"\n"}No wallet needed.
      </Text>

      <View className="w-full max-w-[520px] gap-[12px] rounded-control border border-border-light bg-card-background px-[20px] py-[20px]">
        <Text className="font-pp-medium text-[11px] uppercase tracking-[0.5px] text-text-secondary">Partial viewing key</Text>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="pvk1.…"
          // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
          placeholderTextColor={colors.textMuted}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          className="min-h-[72px] rounded-[8px] border border-border-light p-[12px] font-pp-regular text-[12px] text-text"
          // nw-keep(platform-css): textAlignVertical is not a css-interop-compatible property — the
          // [textAlignVertical:top] arbitrary class compiles to nothing on native, dropping
          // Android's multiline top alignment. Keep it as a plain style (same as passkey-spike).
          style={{ textAlignVertical: 'top' }}
        />
        <Pressable
          className={`items-center justify-center rounded-[8px] py-[14px] ${(phase === 'verifying' || !input.trim()) ? 'bg-[#B8BBBF]' : 'bg-button-primary'}`}
          onPress={() => run(input)}
          disabled={phase === 'verifying' || !input.trim()}
        >
          <Text className="font-pp-semi-bold text-[15px] text-button-primary-text">
            {phase === 'verifying' ? 'Verifying…' : 'Verify'}
          </Text>
        </Pressable>

        {decodeError ? (
          <View className="flex-row items-start gap-[8px] rounded-[8px] border border-[#E3B5AE] bg-[#FBEFED] p-[12px]">
            {/* nw-keep(data-color): fixed status color into the vector-icon sink */}
            <Ionicons name="alert-circle" size={20} color="#BA6B5D" />
            <Text className="flex-1 font-pp-regular text-[13px] leading-[18px] text-[#BA6B5D]">{decodeError}</Text>
          </View>
        ) : null}

        {origin ? <OriginResult entry={origin} rateBook={rateBook} colors={colors} /> : null}

        {batch ? (
          <View className="gap-[10px]">
            {(() => {
              const okCount = batch.filter((b) => b.result.verified).length;
              const allOk = okCount === batch.length;
              return (
                <View className={`flex-row items-start gap-[8px] rounded-[8px] border p-[12px] ${allOk ? 'border-success bg-success-bg' : 'border-[#E3B5AE] bg-[#FBEFED]'}`}>
                  {/* nw-keep(data-color): pass/fail status color (theme token or fixed) into the vector-icon sink */}
                  <Ionicons name={allOk ? 'checkmark-circle' : 'alert-circle'} size={20} color={allOk ? colors.success : '#BA6B5D'} />
                  <Text className={`flex-1 font-pp-regular text-[13px] leading-[18px] ${allOk ? 'text-success' : 'text-[#BA6B5D]'}`}>
                    {`${okCount} of ${batch.length} verified onchain.`}
                  </Text>
                </View>
              );
            })()}
            {batch.map((entry, i) => <BatchRow key={`${entry.bundle.commitment}-${i}`} entry={entry} rateBook={rateBook} colors={colors} />)}
          </View>
        ) : null}

        {!batch && phase === 'done' && result && bundle ? (
          verified ? (
            <View className="flex-row items-start gap-[8px] rounded-[8px] border border-success bg-success-bg p-[12px]">
              {/* nw-keep(data-color): success color (theme token) into the vector-icon sink */}
              <Ionicons name="checkmark-circle" size={20} color={colors.success} />
              <Text className="flex-1 font-pp-regular text-[13px] leading-[18px] text-success">
                Verified onchain. The transaction values below are confirmed.
              </Text>
            </View>
          ) : (
            <View className="flex-row items-start gap-[8px] rounded-[8px] border border-[#E3B5AE] bg-[#FBEFED] p-[12px]">
              {/* nw-keep(data-color): fixed fail color into the vector-icon sink */}
              <Ionicons name="close-circle" size={20} color="#BA6B5D" />
              <Text className="flex-1 font-pp-regular text-[13px] leading-[18px] text-[#BA6B5D]">
                {result.error
                  ? result.error
                  : !result.hashMatch
                    ? 'The key does not match its commitment. The disclosed values were tampered with.'
                    : 'This commitment was not found onchain. The payment may not have settled, or the key is for a different network.'}
              </Text>
            </View>
          )
        ) : null}

        {bundle ? (
          <View className="gap-[9px] rounded-[8px] border border-border-light p-[12px]">
            <Row label="Amount" value={amountLabel ?? '—'} colors={colors} strong={verified} />
            <Row
              label={bundle.kind === 'sent' ? 'Paid to' : 'Owner'}
              value={`${bundle.ownerAddress.slice(0, 6)}…${bundle.ownerAddress.slice(-4)}`}
              colors={colors}
            />
            <Row label="Network" value={chainName ?? '—'} colors={colors} />
            {dateLabel ? <Row label="Date (onchain)" value={dateLabel} colors={colors} /> : null}
            <Pressable
              className="flex-row items-center justify-between gap-[12px]"
              onPress={() => bundle.txHash && Linking.openURL(getExplorerTxUrl(bundle.chainId, bundle.txHash))}
            >
              <Text className="font-pp-medium text-[12px] text-text-muted">Transaction</Text>
              <View className="flex-row shrink items-center gap-[6px]">
                <ExplorerPrivacyHint explorerName={getExplorerName(bundle.chainId)} />
                <Text className="font-pp-regular text-[13px] text-text" numberOfLines={1}>
                  {`${bundle.txHash.slice(0, 10)}…${bundle.txHash.slice(-8)}`}
                </Text>
                {/* nw-keep(data-color): open-in-explorer glyph color (theme token) into the vector-icon sink */}
                <Ionicons name="open-outline" size={13} color={colors.textSecondary} />
              </View>
            </Pressable>
            {bundle.memo ? <Row label="Memo" value={bundle.memo} colors={colors} /> : null}
          </View>
        ) : null}

        <View className="rounded-[8px] bg-background-secondary p-[12px]">
          <Text className="font-pp-regular text-[12px] leading-[17px] text-text-muted">
            Verification recomputes the note&apos;s cryptographic commitment from the disclosed values and checks
            that exact commitment exists onchain. A forged key can&apos;t pass: changing any value breaks the
            commitment, and a made-up commitment was never recorded onchain.
          </Text>
        </View>
      </View>
    </ScrollView>
  );
}

function Row({
  label,
  value,
  colors,
  strong,
}: {
  label: string;
  value: string;
  colors: (typeof Colors)['light'];
  strong?: boolean;
}) {
  return (
    <View className="flex-row items-center justify-between gap-[12px]">
      <Text className="font-pp-medium text-[12px] text-text-muted">{label}</Text>
      <Text className={`text-[13px] text-text ${strong ? 'font-pp-bold' : 'font-pp-regular'}`}>
        {value}
      </Text>
    </View>
  );
}

function BatchRow({ entry, rateBook, colors }: { entry: BatchEntry; rateBook: ShareRateBook | null; colors: (typeof Colors)['light'] }) {
  const { bundle, result } = entry;
  const amount = amountText(rateBook, bundle.chainId, bundle.tokenId, BigInt(bundle.value), { timestampSec: result.onChainTimestampSec });
  const ok = result.verified === true;
  return (
    <View className="flex-row items-center gap-[10px] rounded-[8px] border border-border-light px-[12px] py-[10px]">
      {/* nw-keep(data-color): pass/fail status color (theme token or fixed) into the vector-icon sink */}
      <Ionicons name={ok ? 'checkmark-circle' : 'close-circle'} size={18} color={ok ? colors.success : '#BA6B5D'} />
      <View className="flex-1 gap-[2px]">
        <Text className="font-pp-semi-bold text-[14px] text-text">{amount}</Text>
        <Text className="font-pp-regular text-[11px] text-text-muted" numberOfLines={1}>
          {bundle.memo ? `${bundle.memo} · ` : ''}{`${bundle.ownerAddress.slice(0, 6)}…${bundle.ownerAddress.slice(-4)}`}
        </Text>
      </View>
      <View className="flex-row items-center gap-[6px]">
<Pressable onPress={() => bundle.txHash && Linking.openURL(getExplorerTxUrl(bundle.chainId, bundle.txHash))}>
        {/* nw-keep(data-color): open-in-explorer glyph color (theme token) into the vector-icon sink */}
        <Ionicons name="open-outline" size={15} color={colors.textSecondary} />
      </Pressable>
        <ExplorerPrivacyHint explorerName={getExplorerName(bundle.chainId)} />
      </View>
    </View>
  );
}

function OriginResult({ entry, rateBook, colors }: { entry: OriginEntry; rateBook: ShareRateBook | null; colors: (typeof Colors)['light'] }) {
  const { proof, result } = entry;
  const tokenId = proof.target.tokenId ?? proof.note.tokenId;
  // Only show an amount we actually verified onchain: for a withdrawal that's
  // the Transacted event's withdrawnValue. Exit amounts aren't re-fetched from
  // the event, so we don't display an unverified figure.
  const rawAmt = proof.target.type === 'withdraw' ? result.withdrawnValue : null;
  let amt: string | null = null;
  try {
    if (rawAmt) {
      const at = result.withdrawnBlock ? { block: BigInt(result.withdrawnBlock) } : null;
      amt = amountText(rateBook, proof.chainId, tokenId, BigInt(rawAmt), at);
    }
  } catch { amt = null; }
  const ok = result.verified;
  const label = proof.target.type === 'exit' ? 'Exit' : 'Withdrawal';

  const asp = result.aspStatus;
  const aspText = asp === 'approved' ? 'Approved'
    : asp === 'pending' ? 'Pending review'
    : asp === 'rejected' ? 'Rejected (flagged)'
    : asp === 'poi_required' ? 'Proof of Innocence required'
    : 'Unavailable';
  const aspColor = asp === 'approved' ? colors.success : asp === 'rejected' ? '#BA6B5D' : asp === 'poi_required' ? colors.warning : colors.textSecondary;
  const aspIcon = asp === 'approved' ? 'shield-checkmark' : asp === 'rejected' ? 'alert-circle' : asp === 'poi_required' ? 'alert-circle-outline' : 'help-circle-outline';

  return (
    <>
      {ok ? (
        <View className="flex-row items-start gap-[8px] rounded-[8px] border border-success bg-success-bg p-[12px]">
          {/* nw-keep(data-color): success color (theme token) into the vector-icon sink */}
          <Ionicons name="shield-checkmark" size={20} color={colors.success} />
          <Text className="flex-1 font-pp-regular text-[13px] leading-[18px] text-success">
            Verified onchain. The sender controls a note tied to this {label.toLowerCase()}, belonging to a
            single Privacy Pools lineage. (This shows control of the lineage. It doesn&apos;t prove they were
            the original depositor.)
          </Text>
        </View>
      ) : (
        <View className="flex-row items-start gap-[8px] rounded-[8px] border border-[#E3B5AE] bg-[#FBEFED] p-[12px]">
          {/* nw-keep(data-color): fixed fail color into the vector-icon sink */}
          <Ionicons name="close-circle" size={20} color="#BA6B5D" />
          <Text className="flex-1 font-pp-regular text-[13px] leading-[18px] text-[#BA6B5D]">
            {result.error
              ?? (!result.noteOnChain
                ? 'The disclosed note was not found onchain.'
                : `Could not tie this ${label.toLowerCase()} to the disclosed note.`)}
          </Text>
        </View>
      )}
      <View className="gap-[9px] rounded-[8px] border border-border-light p-[12px]">
        <Row label={proof.target.type === 'exit' ? 'Exit' : 'Withdrawal'} value={amt ?? (proof.target.type === 'exit' ? 'Exit transaction' : '—')} colors={colors} strong={ok} />
        {ok ? (
          <View className="flex-row items-center justify-between gap-[12px]">
            <Text className="font-pp-medium text-[12px] text-text-muted">ASP status</Text>
            <View className="flex-row shrink items-center gap-[6px]">
              {/* nw-keep(data-color): ASP-status color (theme token or fixed) into the vector-icon sink */}
              <Ionicons name={aspIcon} size={14} color={aspColor} />
              {/* nw-keep(data-color): ASP-status text color is a runtime token/fixed value, not a class token */}
              <Text className="font-pp-medium text-[13px]" style={{ color: aspColor }}>{aspText}</Text>
            </View>
          </View>
        ) : null}
        {proof.target.recipient ? (
          <Row label="Paid to" value={`${proof.target.recipient.slice(0, 6)}…${proof.target.recipient.slice(-4)}`} colors={colors} />
        ) : null}
        <Pressable
          className="flex-row items-center justify-between gap-[12px]"
          onPress={() => proof.target.txHash && Linking.openURL(getExplorerTxUrl(proof.chainId, proof.target.txHash))}
        >
          <Text className="font-pp-medium text-[12px] text-text-muted">Transaction</Text>
          <View className="flex-row shrink items-center gap-[6px]">
            <ExplorerPrivacyHint explorerName={getExplorerName(proof.chainId)} />
            <Text className="font-pp-regular text-[13px] text-text" numberOfLines={1}>
              {`${proof.target.txHash.slice(0, 10)}…${proof.target.txHash.slice(-8)}`}
            </Text>
            {/* nw-keep(data-color): open-in-explorer glyph color (theme token) into the vector-icon sink */}
            <Ionicons name="open-outline" size={13} color={colors.textSecondary} />
          </View>
        </Pressable>
        {proof.memo ? <Row label="Memo" value={proof.memo} colors={colors} /> : null}
      </View>
    </>
  );
}
