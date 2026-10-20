/**
 * Personal activity rows for the Stellar account.
 *
 * PURE: the ASP events feed does not index Stellar, so "My activity" had no
 * rows there, and the Exit action (which lives in the row menu) was
 * unreachable. Rows are derived from the notes the account holds plus the
 * origin of each note in the pool's own event history, which the account
 * reads in bulk on its sync clock (services/stellar/stellar-account.ts). No
 * request is keyed on a note (docs/privacy-request-discipline.md).
 *
 * A rediscovered note carries neither its depositSecret nor a usable
 * createdAtBlock, so neither is a signal here. What the chain proves:
 *   Deposit      the note's commitment is the output of a `Deposited` event
 *                whose depositor is this account.
 *   Transfer in  the entry note(s) of a lineage this account did not start:
 *                a deposit output with another depositor, or, when no note of
 *                the lineage is a deposit output at all, its earliest transact
 *                output(s). We hold every note of a lineage we started (its
 *                deposit note is rediscovered with the rest), so a lineage with
 *                no deposit note of ours was started by someone else.
 *   Sent /       a `Transacted` whose nullifiers include one of ours, matched
 *   Withdrawal   locally with this account's nullifying key (the EVM approach,
 *                services/outgoing-transfers.ts). The same bulk page carries
 *                the nullifiers, outputs and withdrawn value.
 *   Exit         a `Ragequit` naming one of our commitments.
 * Who received a send is not on chain, so it is not shown.
 * Nothing is guessed: with no index, or an index that missed some note, only
 * the positively proven Deposit rows are produced.
 */
import type { Transaction } from '@/components/pools-provider';
import { depositRowOutcome, projectDepositFunds, projectReceivedFunds, reviewOutcome, type FundsProjection } from '@/services/funds-state';
import { formatUsd } from '@/services/format-fiat';
import { reconstructUserSpends } from '@/services/outgoing-transfers';
import type { Hex, Secret } from '@/services/sdk-types';

/** The fields of an SDK Note this derivation reads. */
export type StellarActivityNote = {
  commitment: string;
  label: string;
  value: string;
  status: string;
  txHash: string;
  tokenId: string;
  ownerAddress?: string;
  isOwned?: boolean;
};

/** Where one note came from on chain. `time` is unix seconds, 0 when unknown. */
export type StellarNoteOrigin =
  | { kind: 'deposit'; depositor: string; txHash: string; ledger: number; time: number }
  | { kind: 'transact'; txHash: string; ledger: number; time: number };

/** One of this account's spends, as the chain proves it (no secrets). Amounts are base units. */
export type StellarSpend = {
  txHash: string;
  /** internal / fee: a spend with no user-facing amount (a self-transfer); kept so its
   *  outputs are known to be this account's own, never shown as a row. */
  kind: 'transfer' | 'withdrawal' | 'internal' | 'fee';
  /** Transfer: what the recipient got; withdrawal: what left the pool. */
  amount: string;
  tokenId: string;
  ledger: number;
  time: number;
};

/** An exit (ragequit) of one of this account's notes. */
export type StellarExit = { txHash: string; commitment: string; ledger: number; time: number };

export type StellarNoteOrigins = {
  /** Keyed by canonical commitment (see `canonicalCommitment`). */
  byCommitment: Record<string, StellarNoteOrigin>;
  /** Every note held at read time was found in the history. */
  complete: boolean;
  /** Absent when the account's keys were not in memory for the read. */
  spends?: StellarSpend[];
  exits?: StellarExit[];
};

export type StellarActivityContext = {
  chainId: number;
  chainName: string;
  symbol: string;
  decimals: number;
  /** USD per whole token; 0 when unknown. */
  priceUsd: number;
  /** This account's StrKey (G…). */
  ownAddress: string;
  /** Payee this device recorded for one of its sends, if any (local store). */
  sentRecipient?: (txHash: string) => string | null;
};

export type StellarActivity = {
  rows: Transaction[];
  /** Deposits this account made. */
  depositCount: number;
  /** Distinct incoming transfers (one per creating tx). */
  receivedCount: number;
  /** Private sends this account made. */
  sentCount: number;
  /** Relayed withdrawals plus exits. */
  withdrawalCount: number;
};

/** One spelling for a commitment: minimal 0x-hex (the export pads, events do not). */
export function canonicalCommitment(value: string): string {
  try { return `0x${BigInt(value).toString(16)}`; } catch { return String(value).toLowerCase(); }
}

function canonicalTx(value: string): string {
  return String(value ?? '').toLowerCase().replace(/^0x/, '');
}

function toNumber(hex: string): number {
  try { return Number(BigInt(hex)); } catch { return 0; }
}

/**
 * Picks, from the pool's decoded event history, the origin of each held note.
 * Only entries for these notes are kept.
 */
export function buildStellarNoteOrigins(input: {
  notes: readonly { commitment: string }[];
  deposits: readonly { txHash: string; outputCommitment: string; depositor: string }[];
  transacts: readonly { txHash: string; outputCommitments: readonly string[] }[];
  logs: readonly { transactionHash: string; ledger: string; ledgerClosedAt?: string }[];
  /** This account's spends, already matched (`reconstructStellarSpends`). */
  spends?: readonly Omit<StellarSpend, 'ledger' | 'time'>[];
  ragequits?: readonly { txHash: string; commitment: string }[];
}): StellarNoteOrigins {
  const wanted = new Set(input.notes.map((n) => canonicalCommitment(n.commitment)));
  const txAt = new Map<string, { ledger: number; time: number }>();
  for (const log of input.logs) {
    const key = canonicalTx(log.transactionHash);
    if (!key || txAt.has(key)) continue;
    const parsed = log.ledgerClosedAt ? Date.parse(log.ledgerClosedAt) : NaN;
    txAt.set(key, { ledger: toNumber(log.ledger), time: Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0 });
  }
  const at = (txHash: string) => txAt.get(canonicalTx(txHash)) ?? { ledger: 0, time: 0 };
  const byCommitment: Record<string, StellarNoteOrigin> = {};
  for (const d of input.deposits) {
    const c = canonicalCommitment(d.outputCommitment);
    if (!wanted.has(c)) continue;
    byCommitment[c] = { kind: 'deposit', depositor: String(d.depositor), txHash: String(d.txHash), ...at(d.txHash) };
  }
  for (const t of input.transacts) {
    for (const out of t.outputCommitments) {
      const c = canonicalCommitment(out);
      if (!wanted.has(c) || byCommitment[c]) continue;
      byCommitment[c] = { kind: 'transact', txHash: String(t.txHash), ...at(t.txHash) };
    }
  }
  const complete = [...wanted].every((c) => !!byCommitment[c]);
  const exits = input.ragequits
    ?.filter((r) => wanted.has(canonicalCommitment(r.commitment)))
    .map((r) => ({ txHash: String(r.txHash), commitment: canonicalCommitment(r.commitment), ...at(r.txHash) }));
  const spends = input.spends?.map((s) => ({ ...s, ...at(s.txHash) }));
  return { byCommitment, complete, ...(spends ? { spends } : {}), ...(exits ? { exits } : {}) };
}

/**
 * This account's sends and withdrawals among the pool's decoded `Transacted`
 * events: an event spent one of our notes when its nullifiers include
 * Poseidon(nullifyingKey, commitment) for a note we hold (SPENT ones too).
 * Same rule as EVM (services/outgoing-transfers.ts). Self-spends come back
 * as internal / fee (no amount): no row, but their outputs are this account's.
 */
export function reconstructStellarSpends(input: {
  notes: readonly { commitment: string; value: string; tokenId: string; label?: string; txHash?: string }[];
  transacts: readonly {
    txHash: string;
    outputCommitments: readonly string[];
    nullifierHashes: readonly string[];
    withdrawnValue: string;
    asset?: string;
  }[];
  nullifyingKey: string;
  hashService: { hash(inputs: Hex[]): Hex };
}): Omit<StellarSpend, 'ledger' | 'time'>[] {
  const spends = reconstructUserSpends(
    input.notes as unknown as Parameters<typeof reconstructUserSpends>[0],
    input.transacts.map((t, logIndex) => ({
      txHash: String(t.txHash),
      logIndex,
      outputCommitments: t.outputCommitments.map(String),
      nullifierHashes: t.nullifierHashes.map(String),
      caller: '',
      withdrawnValue: String(t.withdrawnValue ?? '0'),
      encryptedPayload: null,
      blockNumber: null,
      blockTimestamp: '',
      asset: String(t.asset ?? ''),
    })),
    input.nullifyingKey as Secret,
    input.hashService,
  );
  const out: Omit<StellarSpend, 'ledger' | 'time'>[] = [];
  for (const s of spends) {
    // Stellar has no swap route, so a 'swap' cannot arise there.
    if (s.kind === 'claim' || s.kind === 'swap') continue;
    out.push({ txHash: s.txHash, kind: s.kind, amount: s.amount.toString(), tokenId: s.tokenId });
  }
  return out;
}

function toBig(value: string): bigint | null {
  try { return BigInt(value); } catch { return null; }
}

function shortAddress(addr: string): string {
  return addr.length >= 10 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr;
}

function sameAccount(a: string, b: string): boolean {
  return !!a && !!b && a.toUpperCase() === b.toUpperCase();
}

/**
 * ASP review of a deposit, as far as its note proves it. ACTIVE (Stellar notes
 * turn ACTIVE only once their label is in the association set) and SPENT (only
 * an approved note can be spent privately) are approved. REJECTED is the note's
 * current standing and can follow an approval, so it proves nothing about the
 * deposit's review: no badge, and the funds column carries the risk. An exited
 * note says nothing about the review either.
 */
export function stellarDepositReview(noteStatus: string): string {
  switch (noteStatus.toUpperCase()) {
    case 'ACTIVE':
    case 'SPENT':
      return 'approved';
    case 'REJECTED':
    case 'EXITED':
    case 'EXIT_PENDING':
      return '';
    default:
      return 'pending';
  }
}

function fundsFields(p: FundsProjection | null): Pick<Transaction, 'fundsState' | 'fundsReason'> {
  return p ? { fundsState: p.state, fundsReason: p.reason } : {};
}

function baseRow(
  note: StellarActivityNote,
  origin: StellarNoteOrigin,
  rawAmount: bigint,
  ctx: StellarActivityContext,
): Omit<Transaction, 'id' | 'type' | 'status' | 'reviewStatus'> {
  const tokenAmount = Number(rawAmount) / 10 ** ctx.decimals;
  const usdValue = tokenAmount * (ctx.priceUsd || 0);
  const tsMs = origin.time > 0 ? origin.time * 1000 : 0;
  const owner = String(note.ownerAddress ?? '');
  return {
    address: shortAddress(owner),
    fullAddress: owner,
    isLineageSynthetic: true,
    chain: ctx.chainName,
    chainId: ctx.chainId,
    asset: ctx.symbol,
    tokenAddress: String(note.tokenId ?? ''),
    rawAmount: rawAmount.toString(),
    tokenAmount,
    usdValue,
    value: formatUsd(usdValue),
    timestamp: tsMs,
    // The note's own txHash: what the row menu and the ragequit modal match on.
    txHash: String(note.txHash ?? ''),
    aspRoot: null,
    label: note.label ?? null,
    noteStatus: String(note.status),
  };
}

export function deriveStellarActivity(
  notes: readonly StellarActivityNote[],
  origins: StellarNoteOrigins | null,
  ctx: StellarActivityContext,
): StellarActivity {
  const empty: StellarActivity = { rows: [], depositCount: 0, receivedCount: 0, sentCount: 0, withdrawalCount: 0 };
  if (!origins) return empty;

  // Own notes only, one per commitment, each with its origin (if indexed).
  const seen = new Set<string>();
  const own: Array<{ note: StellarActivityNote; origin: StellarNoteOrigin | undefined; order: number }> = [];
  for (const n of notes) {
    if (n.isOwned === false || !n.commitment) continue;
    const c = canonicalCommitment(n.commitment);
    if (seen.has(c)) continue;
    seen.add(c);
    own.push({ note: n, origin: origins.byCommitment[c], order: own.length });
  }

  const rows: Transaction[] = [];
  const isOwnDeposit = (o: StellarNoteOrigin | undefined) => o?.kind === 'deposit' && sameAccount(o.depositor, ctx.ownAddress);

  // --- deposits ---
  let depositCount = 0;
  for (const { note, origin } of own) {
    if (!origin || !isOwnDeposit(origin)) continue;
    const raw = toBig(note.value);
    if (raw === null) continue;
    depositCount += 1;
    const noteStatus = String(note.status);
    const reviewStatus = stellarDepositReview(noteStatus);
    // The deposit tx landed (its event proves it); for these states only the
    // review is unknown, which is not a pending deposit.
    const landedReviewUnknown = ['EXITED', 'EXIT_PENDING', 'REJECTED'].includes(noteStatus.toUpperCase());
    rows.push({
      ...baseRow(note, origin, raw, ctx),
      id: `stellar-deposit-${note.commitment}`,
      type: 'Deposit',
      reviewStatus,
      status: landedReviewUnknown ? 'completed' : depositRowOutcome(noteStatus, reviewOutcome(reviewStatus)),
      ...fundsFields(projectDepositFunds({
        reviewStatus,
        noteStatus,
        // ACTIVE already means "in the association set" on Stellar.
        leafReady: false,
        leafConfirmed: false,
        registration: 'unknown',
        discoveryReady: true,
      })),
    });
  }

  // --- received: only from a complete index ---
  let receivedCount = 0;
  if (origins.complete) {
    const byLabel = new Map<string, typeof own>();
    for (const entry of own) {
      const label = String(entry.note.label).toLowerCase();
      if (!label) continue;
      const group = byLabel.get(label) ?? [];
      group.push(entry);
      byLabel.set(label, group);
    }
    const receivedByTx = new Map<string, { note: StellarActivityNote; origin: StellarNoteOrigin; sum: bigint; order: number }>();
    for (const group of byLabel.values()) {
      // Notes made after the index was read (our own flow's outputs) have no
      // origin yet; they are necessarily later, so they never decide the entry.
      const known = group.filter((e) => !!e.origin) as Array<{ note: StellarActivityNote; origin: StellarNoteOrigin; order: number }>;
      if (known.length === 0 || known.some((e) => isOwnDeposit(e.origin))) continue;
      const foreignDeposits = known.filter((e) => e.origin.kind === 'deposit');
      let entries: typeof known;
      if (foreignDeposits.length > 0) {
        entries = foreignDeposits;
      } else {
        // The lineage's first transact. Two txs in its first ledger cannot be
        // ordered from what the index holds, so that lineage gets no row
        // rather than a guessed one.
        const first = Math.min(...known.map((e) => e.origin.ledger));
        entries = known.filter((e) => e.origin.ledger === first);
        if (new Set(entries.map((e) => canonicalTx(e.origin.txHash))).size !== 1) continue;
      }
      for (const e of entries) {
        const raw = toBig(e.note.value);
        const key = canonicalTx(e.origin.txHash);
        if (raw === null || !key) continue;
        const acc = receivedByTx.get(key);
        if (acc) acc.sum += raw;
        else receivedByTx.set(key, { note: e.note, origin: e.origin, sum: raw, order: e.order });
      }
    }
    for (const { note, origin, sum } of [...receivedByTx.values()].sort((a, b) => a.order - b.order)) {
      rows.push({
        ...baseRow(note, origin, sum, ctx),
        id: `stellar-in-${note.commitment}`,
        type: 'Transfer',
        direction: 'in',
        // The ASP reviewed the sender's deposit, not this receipt.
        reviewStatus: 'approved',
        status: 'completed',
        ...fundsFields(projectReceivedFunds({
          noteStatus: String(note.status),
          leafReady: false,
          leafConfirmed: false,
          registration: 'unknown',
        })),
      });
    }
    receivedCount = receivedByTx.size;
  }

  // --- sent / withdrawn: matched by nullifier at sync time ---
  let sentCount = 0;
  let withdrawalCount = 0;
  for (const spend of origins.spends ?? []) {
    if (spend.kind !== 'transfer' && spend.kind !== 'withdrawal') continue;
    const raw = toBig(spend.amount);
    if (raw === null) continue;
    const isTransfer = spend.kind === 'transfer';
    if (isTransfer) sentCount += 1;
    else withdrawalCount += 1;
    const payee = isTransfer ? ctx.sentRecipient?.(spend.txHash) ?? '' : '';
    rows.push({
      ...eventRow(spend.txHash, spend.tokenId, raw, spend.time, ctx),
      address: shortAddress(payee),
      fullAddress: payee,
      id: `stellar-out-${spend.txHash}`,
      type: isTransfer ? 'Transfer' : 'Withdrawal',
      direction: isTransfer ? 'out' : undefined,
      reviewStatus: 'approved',
      status: 'completed',
      label: null,
    });
  }

  // --- exits: a Ragequit of one of our notes ---
  const ownByCommitment = new Map(own.map((e) => [canonicalCommitment(e.note.commitment), e.note]));
  for (const exit of origins.exits ?? []) {
    const note = ownByCommitment.get(canonicalCommitment(exit.commitment));
    const raw = note ? toBig(note.value) : null;
    if (!note || raw === null) continue;
    withdrawalCount += 1;
    rows.push({
      ...eventRow(exit.txHash, String(note.tokenId ?? ''), raw, exit.time, ctx),
      id: `stellar-exit-${exit.txHash}`,
      type: 'Exit',
      reviewStatus: '',
      status: 'completed',
      label: note.label ?? null,
      noteStatus: String(note.status),
    });
  }

  // Newest first by chain time; stable, so rows with no time keep their order.
  rows.sort((a, b) => b.timestamp - a.timestamp);
  return { rows, depositCount, receivedCount, sentCount, withdrawalCount };
}

/** A row for an event this account caused (a spend or an exit): no counterparty is shown. */
function eventRow(
  txHash: string,
  tokenId: string,
  rawAmount: bigint,
  time: number,
  ctx: StellarActivityContext,
): Omit<Transaction, 'id' | 'type' | 'status' | 'reviewStatus' | 'label'> {
  const tokenAmount = Number(rawAmount) / 10 ** ctx.decimals;
  const usdValue = tokenAmount * (ctx.priceUsd || 0);
  const tsMs = time > 0 ? time * 1000 : 0;
  return {
    address: '',
    fullAddress: '',
    isLineageSynthetic: true,
    chain: ctx.chainName,
    chainId: ctx.chainId,
    asset: ctx.symbol,
    tokenAddress: tokenId,
    rawAmount: rawAmount.toString(),
    tokenAmount,
    usdValue,
    value: formatUsd(usdValue),
    timestamp: tsMs,
    txHash: String(txHash),
    aspRoot: null,
  };
}

/**
 * Deposits this Stellar account made, from its notes and their origins alone.
 * Needs no active chain, so a count read while another chain is selected still
 * includes them.
 */
export function countStellarDeposits(
  notes: readonly Pick<StellarActivityNote, 'commitment' | 'isOwned'>[],
  origins: StellarNoteOrigins | null,
  ownAddress: string,
): number {
  if (!origins || !ownAddress) return 0;
  const counted = new Set<string>();
  for (const n of notes) {
    if (n.isOwned === false || !n.commitment) continue;
    const c = canonicalCommitment(n.commitment);
    const origin = origins.byCommitment[c];
    if (origin?.kind === 'deposit' && sameAccount(origin.depositor, ownAddress)) counted.add(c);
  }
  return counted.size;
}

/**
 * Payee lookup over this device's sent-transfer records, matching a Stellar
 * tx hash in either spelling (with or without 0x, any case).
 */
export function stellarSentRecipientLookup(
  records: readonly { txHash: string; recipient: string; chainId: number }[],
  chainId: number,
): (txHash: string) => string | null {
  const byTx = new Map<string, string>();
  for (const r of records) {
    if (r.chainId === chainId && r.recipient) byTx.set(canonicalTx(r.txHash), r.recipient);
  }
  return (txHash) => byTx.get(canonicalTx(txHash)) ?? null;
}

/**
 * Notes this account RECEIVED, with their chain time as createdAtBlock (unix
 * seconds, hex), for matching Stellar payment requests as paid
 * (services/session-request-fulfillment.ts). Excludes its own deposits and the
 * outputs of its own spends (change), which are not payments.
 */
export function stellarReceivedNotes(
  notes: readonly StellarActivityNote[],
  origins: StellarNoteOrigins | null,
  ownAddress: string,
): { commitment: string; tokenId: string; value: string; createdAtBlock: string; txHash: string }[] {
  // An index that missed a note could make an ambiguous payment look unique.
  if (!origins?.complete) return [];
  const ownSpendTx = new Set((origins.spends ?? []).map((s) => canonicalTx(s.txHash)));
  const out: { commitment: string; tokenId: string; value: string; createdAtBlock: string; txHash: string }[] = [];
  for (const n of notes) {
    if (n.isOwned === false) continue;
    const origin = origins.byCommitment[canonicalCommitment(n.commitment)];
    if (!origin || origin.time <= 0) continue;
    if (origin.kind === 'deposit' && sameAccount(origin.depositor, ownAddress)) continue;
    if (origin.kind === 'transact' && ownSpendTx.has(canonicalTx(origin.txHash))) continue;
    out.push({ commitment: n.commitment, tokenId: n.tokenId, value: n.value, createdAtBlock: `0x${origin.time.toString(16)}`, txHash: origin.txHash });
  }
  return out;
}
