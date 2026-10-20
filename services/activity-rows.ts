// The activity rows the provider builds from the account's own notes and
// reconstructed spends (#215): received and sent lineage rows, and one Swap
// row per private swap. Moved out of components/pools-provider.tsx so the
// exact assembly the provider runs is bun-testable; the device stores it
// needs (a send's recorded payee, the leaf gate) are passed in.
//
// PURE module (no react-native imports).

import type { Transaction } from '@/components/pools-provider';
import { getChainConfig } from '@/config/chains';
import { getTokenMetadata, isStablecoin } from '@/config/tokens';
import { formatUsd } from '@/services/format-fiat';
import { noteTimeMs } from '@/services/own-actions-core';
import { snapshotTimestampToMs, type UserSpend } from '@/services/outgoing-transfers';
import { priceFromMap } from '@/services/price-map-merge';
import { aggregateOutputStatus, hexKey, type OwnOutputProjection, type SwapLeg } from '@/services/swap-rows';
import type { CrossChainSwapRecord, SwapRecord } from '@/services/swap-records-core';

export type RecipientLookup = (txHash: string) => string | null | undefined;

/** One of my notes on a chain, by commitment (any spelling). */
export type NoteLookup = (chainId: number, commitment: string) => { status: string; label: string; commitment: string; value: string; tokenId: string; txHash?: string } | null;

/** A leg in its own chain's token, priced like the row it belongs to. */
export function legOf(chainId: number, tokenAddress: string, rawAmount: string, priceMap: Record<string, number>): SwapLeg {
  const meta = getTokenMetadata(tokenAddress, chainId);
  const upper = meta.symbol.toUpperCase();
  const price = priceFromMap(priceMap, { chainId, address: tokenAddress, symbol: upper }) || (isStablecoin(upper) ? 1 : 0);
  let raw = 0n;
  try { raw = BigInt(rawAmount); } catch { /* malformed: zero */ }
  const tokenAmount = Number(raw) / 10 ** (meta.decimals ?? 18);
  return {
    chainId,
    chain: getChainConfig(chainId)?.displayName || String(chainId),
    asset: meta.symbol,
    tokenAddress,
    rawAmount: raw.toString(),
    tokenAmount,
    usdValue: tokenAmount * price,
  };
}

type OutputStatusFields = Pick<Transaction, 'status' | 'reviewStatus' | 'noteStatus' | 'fundsState' | 'fundsReason'>;

// #215: build an activity row from an owned note's lineage (a received root or
// a change/spend), for lineages the global events feed doesn't attribute to the
// connected address (or has dropped past its window). type stays 'Transfer' with
// the note's real txHash/label so the existing classifyTransfer/audit pipeline
// handles it; `direction` is set from the lineage so it doesn't need the
// sender-stamp guess.

export function buildLineageTransferRow(
  note: { commitment: string; txHash?: string; label?: string | null; tokenId: string; value: string; createdAtBlock?: string; ownerAddress?: string },
  direction: 'in' | 'out',
  rawAmount: bigint,
  chainId: number,
  priceMap: Record<string, number>,
  /** The creating tx's block time, when the snapshot has it. */
  txTimeMs?: number,
): Transaction {
  const tokenAddr = String(note.tokenId || '');
  const meta = getTokenMetadata(tokenAddr, chainId);
  const symbol = meta.symbol;
  const decimals = meta.decimals ?? 18;
  const upper = symbol.toUpperCase();
  // The row's own chain's price (see mapEventToTransaction).
  const price = priceFromMap(priceMap, { chainId, address: tokenAddr, symbol: upper }) || (isStablecoin(upper) ? 1 : 0);
  const tokenAmount = Number(rawAmount) / 10 ** decimals;
  const usdValue = tokenAmount * price;
  // createdAtBlock is healed to a unix-seconds timestamp; render it as ms. A
  // block NUMBER still sitting there (not healed yet) is 0, not 1970.
  const tsMs = txTimeMs ?? noteTimeMs(note.createdAtBlock);
  const owner = String(note.ownerAddress || '');
  return {
    id: `lineage-${note.commitment}`,
    address: owner.length >= 10 ? `${owner.slice(0, 6)}...${owner.slice(-4)}` : owner,
    fullAddress: owner,
    type: 'Transfer',
    direction,
    isLineageSynthetic: true,
    chain: getChainConfig(chainId)?.displayName || 'ETH',
    chainId,
    asset: symbol,
    tokenAddress: tokenAddr,
    rawAmount: rawAmount.toString(),
    tokenAmount,
    usdValue,
    value: formatUsd(usdValue),
    timestamp: tsMs,
    status: 'completed',
    txHash: String(note.txHash || ''),
    reviewStatus: 'approved',
    aspRoot: null,
    label: note.label ?? null,
  };
}

// #215 follow-up: build a 'Transfer Out' / 'Withdrawal' row from a user spend
// reconstructed cross-device (services/outgoing-transfers.ts) — exact amount,
// no per-device stamp. Surfaces only in the personal "My Transactions" scope,
// like the received rows.
export function buildUserSpendRow(
  spend: UserSpend,
  chainId: number,
  priceMap: Record<string, number>,
  /** The payee this device recorded for its own send, by tx hash. */
  recipientOf: RecipientLookup = () => null,
): Transaction {
  const tokenAddr = String(spend.tokenId || '');
  const meta = getTokenMetadata(tokenAddr, chainId);
  const symbol = meta.symbol;
  const decimals = meta.decimals ?? 18;
  const upper = symbol.toUpperCase();
  // The row's own chain's price (see mapEventToTransaction).
  const price = priceFromMap(priceMap, { chainId, address: tokenAddr, symbol: upper }) || (isStablecoin(upper) ? 1 : 0);
  // A 'fee' spend carries no amount ON PURPOSE (services/transact-shape.ts):
  // value left the pool, but it went to the relayer, not to the user. The
  // figure worth showing is therefore the fee itself, which is also the only
  // change to the balance. Every output is mine, so it is a transfer to myself
  // (services/self-transfer-row.ts).
  const isSelf = spend.kind === 'fee';
  const shownRaw = isSelf ? spend.fee : spend.amount;
  const tokenAmount = Number(shownRaw) / 10 ** decimals;
  const usdValue = tokenAmount * price;
  const tsMs = snapshotTimestampToMs(spend.blockTimestamp);
  const isTransfer = spend.kind === 'transfer';
  // A claim of a received note: the receipt, not a spend (DEV-450).
  const isClaim = spend.kind === 'claim';
  // The recipient is not recoverable from chain data (it is the recipient's
  // note, not ours) — but when WE were the sender we wrote it down locally, so
  // look it up instead of rendering "?" at the user. A tester read his own
  // payment-request payment as missing money because this row was anonymous
  // (Mike, 2026-08-26). Sent transfers and paid payment requests are both
  // keyed by txHash; either one names the payee.
  const knownRecipient = isClaim || isSelf ? '' : (recipientOf(spend.txHash) ?? '');
  return {
    id: isClaim ? `lineage-claim-${spend.txHash}` : `lineage-out-${spend.txHash}`,
    ...(isClaim ? { claimTxHash: spend.txHash, claimCostRaw: spend.fee.toString() } : {}),
    ...(isClaim && spend.withRegistration ? { withRegistration: true } : {}),
    ...(isClaim && spend.claimTxHashes ? { claimTxHashes: spend.claimTxHashes } : {}),
    ...(isSelf
      ? { ...(spend.consolidation ? { noteCounts: spend.consolidation } : {}), movedAmountRaw: spend.ownOutputValue.toString() }
      : {}),
    ...(isTransfer && spend.fee > 0n ? { relayFeeRaw: spend.fee.toString() } : {}),
    address: knownRecipient.length >= 10
      ? `${knownRecipient.slice(0, 6)}...${knownRecipient.slice(-4)}`
      : knownRecipient,
    fullAddress: knownRecipient,
    type: isTransfer || isClaim || isSelf ? 'Transfer' : 'Withdrawal',
    direction: isTransfer ? 'out' : isClaim ? 'in' : isSelf ? 'self' : undefined,
    isLineageSynthetic: true,
    chain: getChainConfig(chainId)?.displayName || 'ETH',
    chainId,
    asset: symbol,
    tokenAddress: tokenAddr,
    rawAmount: shownRaw.toString(),
    tokenAmount,
    usdValue,
    value: formatUsd(usdValue),
    timestamp: tsMs,
    status: 'completed',
    // A claim row is the receipt, so it names the payment, which is also the
    // hash any feed row for the same payment carries (they dedupe by it).
    txHash: isClaim ? spend.receivedTxHash ?? spend.txHash : spend.txHash,
    reviewStatus: 'approved',
    aspRoot: null,
    label: null,
  };
}

// A private swap's row (services/swap-rows.ts): the source leg is the spend,
// the output leg is the note the same tx deposited on the same chain, and the
// status fields are the output's.
export function buildSwapRow(
  spend: UserSpend,
  chainId: number,
  priceMap: Record<string, number>,
  outputStatus: OutputStatusFields,
): Transaction {
  const source = buildUserSpendRow(spend, chainId, priceMap);
  const outputs = spend.swapOutputs ?? [];
  const outRaw = outputs.reduce((sum, o) => sum + o.value, 0n);
  return {
    ...source,
    id: `lineage-swap-${spend.txHash}`,
    type: 'Swap',
    direction: undefined,
    address: '',
    fullAddress: '',
    ...outputStatus,
    swapOut: {
      ...legOf(chainId, String(outputs[0]?.tokenId ?? ''), outRaw.toString(), priceMap),
      txHash: spend.txHash.toLowerCase(),
      labels: outputs.map((o) => hexKey(o.label)),
      commitments: outputs.map((o) => hexKey(o.commitment)),
      sourceLabels: (spend.inputLabels ?? []).map(hexKey),
    },
  };
}

/** The local projection's fields as a row's. */
function projectionFields(p: OwnOutputProjection): OutputStatusFields {
  return {
    status: p.status,
    reviewStatus: p.reviewStatus,
    noteStatus: p.noteStatus,
    ...(p.funds ? { fundsState: p.funds.state, fundsReason: p.funds.reason } : {}),
  };
}

/**
 * A swap output's status: its Deposit rows' once the ASP has indexed every
 * output (those rows fold into the Swap row), local evidence until then, the
 * same projection a synthesized own Deposit uses. Matched by chain and label.
 */
export function swapOutputStatus(
  spend: UserSpend,
  chainId: number,
  feedRows: readonly Transaction[],
  projectLocalOutputs: (chainId: number, outputs: readonly { status: string; commitment: string }[]) => OwnOutputProjection | null,
): OutputStatusFields | null {
  const outputs = spend.swapOutputs ?? [];
  if (outputs.length === 0) return null;
  const labels = outputs.map((o) => hexKey(o.label));
  const outRows = feedRows.filter((t) => t.type === 'Deposit' && t.chainId === chainId && !!t.label && labels.includes(hexKey(t.label)));
  if (labels.every((l) => outRows.some((r) => hexKey(r.label) === l))) return aggregateOutputStatus(outRows);
  const local = projectLocalOutputs(chainId, outputs.map((o) => ({ status: o.status ?? '', commitment: o.commitment })));
  return local ? projectionFields(local) : null;
}

/**
 * Outgoing rows from the cross-device reconstruction
 * (services/outgoing-transfers.ts): 'Transfer Out' with the exact
 * recipient-facing amount, 'Withdrawal' with the value that left the pool,
 * 'Swap' with both legs. 'internal' spends (self merge/split) get no row.
 *
 * These are ALWAYS emitted, even when an ASP event row exists for the same tx:
 * that row is misdirected on a device with no local sent-stamp, and the My
 * Transactions merge prefers the lineage row. `seenTxHashes` holds the rows
 * already emitted (a received row), so none double-emits; it is updated.
 * Pass claims merged by payment (one row per claimed payment).
 */
export function buildSpendRows(input: {
  spends: readonly UserSpend[];
  seenTxHashes: Set<string>;
  defaultChainId: number;
  /** The processed feed rows: a swap output's indexed Deposit row is here. */
  feedRows: readonly Transaction[];
  priceMap: Record<string, number>;
  projectLocalOutputs: (chainId: number, outputs: readonly { status: string; commitment: string }[]) => OwnOutputProjection | null;
  recipientOf?: RecipientLookup;
  /** This device's swap records (services/swap-records-core.ts). They only
   *  decorate or link spends the classifier already found to be mine. */
  records?: readonly SwapRecord[];
  /** My notes on every chain, for a cross-chain swap's destination note. */
  noteOn?: NoteLookup;
  /** Every chain's snapshot deposit commitments: a listed destination note was delivered. */
  depositCommitments?: ReadonlySet<string>;
  /** This device's own setup actions (services/own-actions-core.ts), by spend
   *  tx: a relayed spend made only to register or to pay for the viewing key. */
  setupKindOf?: (chainId: number, txHash: string) => Transaction['setupKind'] | null;
}): Transaction[] {
  const rows: Transaction[] = [];
  const recordFor = (chainId: number, txHash: string) =>
    input.records?.find((r) => r.sourceChainId === chainId && r.txHash === txHash) ?? null;
  for (const spend of input.spends) {
    if (spend.kind === 'internal') continue;
    const spendTx = spend.txHash.toLowerCase();
    // A claim row is keyed by the payment it is the receipt of.
    const rowTx = spend.kind === 'claim' ? spend.receivedTxHash ?? spendTx : spendTx;
    if (!spendTx || input.seenTxHashes.has(rowTx)) continue;
    input.seenTxHashes.add(rowTx);
    // The spend's own chain: spends come from every chain's notes.
    const chainId = spend.chainId ?? input.defaultChainId;
    if (spend.kind === 'swap') {
      const status = swapOutputStatus(spend, chainId, input.feedRows, input.projectLocalOutputs);
      if (status) {
        rows.push(buildSwapRow(spend, chainId, input.priceMap, status));
        continue;
      }
    }
    const row = buildUserSpendRow(spend, chainId, input.priceMap, input.recipientOf);
    // Account setup paid from the balance: one row, named for what it was,
    // never a bare Withdrawal (DEV-574).
    const setupKind = spend.kind === 'withdrawal' || spend.kind === 'fee' ? input.setupKindOf?.(chainId, spendTx) ?? null : null;
    if (setupKind) {
      rows.push({ ...row, setupKind });
      continue;
    }
    const record = spend.kind === 'withdrawal' ? recordFor(chainId, spendTx) : null;
    if (record?.kind === 'cross-chain') {
      rows.push(crossChainRow(row, spend, record, input));
      continue;
    }
    if (record?.kind === 'receive-as') {
      rows.push({ ...row, receivedAs: legOf(record.outputChainId, record.outputToken, record.quotedOutput, input.priceMap) });
      continue;
    }
    // A private swap-send, known only from this device's record. Chain data
    // cannot tell it from a receive-as payout or my own reshield whose output
    // is not synced yet (a relayed tx can be a batch), so without the record
    // the row stays "Withdrawal via swap". A cross-chain send whose far leg
    // did not deposit says how it ended instead (DEV-512 review).
    if (record?.kind === 'send') {
      const outcome = record.outcome;
      rows.push(outcome === 'recovered' || outcome === 'refunded' || outcome === 'failed'
        ? { ...row, viaSwap: true, delivery: outcome }
        : { ...row, viaSwap: true, sentToOther: true });
      continue;
    }
    // No record here, but a RelaySwaps caller: a cross-chain swap or a
    // receive-as payout made elsewhere. Nothing names its output.
    rows.push(spend.kind === 'withdrawal' && spend.swapRoute ? { ...row, viaSwap: true } : row);
  }
  return rows;
}

/**
 * A cross-chain Swap-tab swap on the device that sent it. A bridge that did
 * not deposit leaves a Withdrawal, saying how it ended. Otherwise one Swap
 * row: the output is the prepared note until delivery is proven (the
 * poller's 'deposited', the note settled ACTIVE or SPENT, or the snapshot
 * listing it), then the delivered deposit, whose row folds in. A prepared
 * note alone proves intent, not delivery.
 */
function crossChainRow(
  source: Transaction,
  spend: UserSpend,
  record: CrossChainSwapRecord,
  input: Parameters<typeof buildSpendRows>[0],
): Transaction {
  if (record.outcome === 'recovered' || record.outcome === 'refunded' || record.outcome === 'failed') {
    return { ...source, delivery: record.outcome };
  }
  const note = input.noteOn?.(record.outputChainId, record.commitment) ?? null;
  const noteStatus = String(note?.status ?? '').toUpperCase();
  const delivered = record.outcome === 'deposited'
    || noteStatus === 'ACTIVE' || noteStatus === 'SPENT'
    || !!input.depositCommitments?.has(hexKey(record.commitment));
  // The output is the owned note when this device holds it: its own token and
  // value, never the record's. The record stands in only for a note not held.
  const leg = note
    ? legOf(record.outputChainId, note.tokenId, note.value, input.priceMap)
    : legOf(record.outputChainId, record.outputToken, record.value, input.priceMap);
  const labels = note?.label ? [hexKey(note.label)] : [];
  let status: OutputStatusFields = { status: 'pending', reviewStatus: '' };
  if (delivered) {
    const outRows = input.feedRows.filter((t) => t.type === 'Deposit' && t.chainId === record.outputChainId && !!t.label && labels.includes(hexKey(t.label)));
    const local = note ? input.projectLocalOutputs(record.outputChainId, [{ status: note.status, commitment: note.commitment }]) : null;
    status = outRows.length > 0
      ? aggregateOutputStatus(outRows) ?? status
      : local ? projectionFields(local) : { status: 'completed', reviewStatus: 'pending' };
  }
  return {
    ...source,
    id: `lineage-swap-${source.txHash}`,
    type: 'Swap',
    direction: undefined,
    address: '',
    fullAddress: '',
    ...status,
    swapOut: {
      ...leg,
      // The deposit identity (fully spent, Exit filter, row actions) is the
      // held note's own tx, the source hash it was stored under; the delivery
      // tx is only the receive link.
      txHash: (note?.txHash || source.txHash).toLowerCase(),
      labels,
      commitments: [hexKey(record.commitment)],
      sourceLabels: (spend.inputLabels ?? []).map(hexKey),
      ...(record.destinationTxHash ? { deliveryTxHash: record.destinationTxHash } : {}),
      ...(delivered ? {} : { delivering: true }),
    },
  };
}

/**
 * The Deposit rows of this device's own Shield swap-and-shield, with what the
 * wallet paid. Matched by the deposit note's commitment through its label on
 * the deposit's chain, whatever the row's hash, so the decoration survives the
 * pending-to-feed handoff. Copies, never mutates.
 */
export function withShieldSwapSources(
  rows: readonly Transaction[],
  records: readonly SwapRecord[],
  noteOn: NoteLookup,
  priceMap: Record<string, number>,
): Transaction[] {
  const byLabel = new Map<string, SwapLeg>();
  for (const r of records) {
    if (r.kind !== 'shield') continue;
    const note = noteOn(r.depositChainId, r.commitment);
    if (!note?.label) continue;
    byLabel.set(`${r.depositChainId}|${hexKey(note.label)}`, legOf(r.sourceChainId, r.inputToken, r.estimatedInput, priceMap));
  }
  if (byLabel.size === 0) return rows as Transaction[];
  return rows.map((row) => {
    if (row.type !== 'Deposit' || !row.label) return row;
    const leg = byLabel.get(`${row.chainId}|${hexKey(row.label)}`);
    return leg ? { ...row, swappedFrom: leg } : row;
  });
}

/**
 * The All tab's feed Withdrawal rows of my own withdrawals, with the same
 * decorations my lineage rows carry (what it was received as, how a bridge
 * ended, the recipient this device recorded), so All and My agree. Only where the feed has exactly one Withdrawal
 * for the hash on that chain: a batch row could be someone else's.
 */
export function withWithdrawalDecorations(feedRows: readonly Transaction[], lineageRows: readonly Transaction[]): Transaction[] {
  const decorated = lineageRows.filter((r) => r.type === 'Withdrawal' && (r.receivedAs || r.delivery || r.viaSwap || r.sentToOther || r.fullAddress));
  if (decorated.length === 0) return feedRows as Transaction[];
  const key = (r: Pick<Transaction, 'chainId' | 'txHash'>) => `${r.chainId}|${String(r.txHash || '').toLowerCase()}`;
  const counts = new Map<string, number>();
  for (const r of feedRows) if (r.type === 'Withdrawal') counts.set(key(r), (counts.get(key(r)) ?? 0) + 1);
  const byKey = new Map(decorated.map((r) => [key(r), r]));
  return feedRows.map((row) => {
    if (row.type !== 'Withdrawal' || counts.get(key(row)) !== 1) return row;
    const own = byKey.get(key(row));
    if (!own) return row;
    return {
      ...row,
      ...(own.receivedAs ? { receivedAs: own.receivedAs } : {}),
      ...(own.delivery ? { delivery: own.delivery } : {}),
      ...(own.viaSwap ? { viaSwap: true } : {}),
      ...(own.sentToOther ? { sentToOther: true } : {}),
      // The recipient this device recorded, where the feed names none.
      ...(!row.fullAddress && own.fullAddress ? { fullAddress: own.fullAddress, address: own.address, recordedRecipient: true } : {}),
    };
  });
}

/**
 * The decorations my own rows carry, applied the same way to the feed and to
 * my lineage rows: what a Shield swap-and-shield paid (needs a record), and on
 * the feed's own Withdrawal rows what my lineage rows say about them (via
 * swap, received as, delivery, recipient), which needs no record. Copies.
 */
export function decorateOwnRows(input: {
  feedRows: readonly Transaction[];
  lineageRows: readonly Transaction[];
  records: readonly SwapRecord[];
  noteOn: NoteLookup;
  priceMap: Record<string, number>;
}): { feedRows: Transaction[]; lineageRows: Transaction[] } {
  const lineageRows = withShieldSwapSources(input.lineageRows, input.records, input.noteOn, input.priceMap);
  const feedRows = withWithdrawalDecorations(withShieldSwapSources(input.feedRows, input.records, input.noteOn, input.priceMap), lineageRows);
  return { feedRows, lineageRows };
}

/**
 * My Pools counts from the classified actions, the same ones the rows show.
 * A claim is the receipt of a transfer whose change note the received count
 * skips; a fee-only spend is a transfer to myself. A spend shown as a Swap row
 * counts as a swap (a cross-chain one while its delivery is pending too); one
 * shown as a Withdrawal (a bridge that recovered or failed) counts as a
 * withdrawal. Only deposits a Swap row actually folds in leave the deposit
 * count (`depositCount` is the snapshot's, which lists them); the per-pool
 * counts keep them.
 */
export function countSpendActions(input: {
  /** Claims merged by payment, so one payment counts once. */
  spends: readonly UserSpend[];
  /** The rows buildSpendRows made from those spends. */
  spendRows: readonly Transaction[];
  receivedCount: number;
  exitCount: number;
  depositCount: number;
  snapshotDeposits: readonly { outputCommitment: string }[];
}): { transfers: number; withdrawals: number; swaps: number; deposits: number } {
  const swapRows = input.spendRows.filter((r) => r.type === 'Swap' && r.swapOut);
  const swapTx = new Set(swapRows.map((r) => r.txHash.toLowerCase()));
  const folded = new Set(swapRows.flatMap((r) => r.swapOut?.commitments ?? []));
  let transfers = input.receivedCount;
  let withdrawals = input.exitCount;
  for (const s of input.spends) {
    if (swapTx.has(s.txHash.toLowerCase())) continue;
    if (s.kind === 'transfer' || s.kind === 'claim' || s.kind === 'fee') transfers += 1;
    else if (s.kind === 'withdrawal' || s.kind === 'swap') withdrawals += 1;
  }
  let deposits = input.depositCount;
  for (const dep of input.snapshotDeposits) if (folded.has(hexKey(dep.outputCommitment))) deposits -= 1;
  return { transfers, withdrawals, swaps: swapRows.length, deposits };
}
