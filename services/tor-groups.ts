import { isHex, keccak256 } from 'viem';

/**
 * Which anon-rpc worker carries a request: its isolation group.
 *
 * Requests on one worker leave from one exit, so whoever sees two of them can
 * link them. The rule (owner ruling, 2026-10-21, "Identity first"): traffic that
 * identifies the user never shares a worker with anything else.
 *
 * - A request that names one of the user's accounts, or that one of them
 *   signs, goes to that account's group, whoever sends it: balances, token
 *   lists, keystore checks, a screening check, a Sui transaction whose
 *   sender it carries. A request naming two (a wallet paying into an imported key's account)
 *   already links them for whoever receives it, so it goes over the first
 *   one's group, the session's, rather than a third worker.
 * - A request about one transaction (broadcasting a signed EVM one, whose
 *   signer the request does not name, or a receipt or status lookup) goes to
 *   that transaction's group. Its sender is public on
 *   chain, but the account that asks need not be the one that sent it, and a
 *   lookup that outlives its flow must not join the next one.
 * - An operation (a withdrawal, transfer, swap, or reshield, from review to the
 *   end) has a group of its own for what it says about itself: relayer quotes
 *   and relays, LI.FI quotes and statuses, targeted ASP calls. The next
 *   operation gets a new one.
 * - Everything else is public (bulk chain reads, public ASP data, prices) and
 *   shares a group per service, or one group when the worker budget is tight
 *   (services/tor-fetch.ts).
 *
 * A request carries a party, which says who receives it and so what it can
 * reveal, and its text (URL and body), which is searched for known accounts.
 */

/** Who receives a request. */
export type TorParty = 'rpc' | 'asp' | 'relayer' | 'lifi' | 'web' | 'sentry';

/** Parties whose requests describe the operation in progress, if there is one. */
const OPERATION_PARTIES: ReadonlySet<TorParty> = new Set(['relayer', 'lifi']);

/** What a request is about, when its text alone cannot say. */
export type TorSubject = {
  /** The account that signs or acts in it, such as a transaction's signer. */
  account?: string | null;
  /** The transaction it sends or asks about. */
  transaction?: string | null;
  /**
   * It identifies the user without naming an account (a targeted ASP query
   * about a label).
   */
  identifying?: boolean;
};

const accounts = new Set<string>();
let operation: string | null = null;
let operations = 0;

function needle(account: string): string | null {
  const hex = /^0x([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.exec(account);
  if (hex) return hex[1].toLowerCase();
  // Stellar account ids are case-sensitive base32.
  return /^G[A-Z2-7]{55}$/.test(account) ? account : null;
}

/**
 * The user's accounts, as the wallet and session providers know them now, the
 * session's identity first. Accounts set before stay known after these, so a
 * late request about an account the user has left still goes over its group.
 */
export function setTorAccounts(list: readonly (string | null | undefined)[]): void {
  const earlier = [...accounts];
  accounts.clear();
  for (const account of list) {
    const key = account ? needle(account) : null;
    if (key) accounts.add(key);
  }
  for (const key of earlier) accounts.add(key);
}

/**
 * Add an account before its first request, ahead of the providers' list:
 * an identity that is still being set up reads the chain before it is the
 * session's.
 */
export function addTorAccount(account: string): void {
  const key = needle(account);
  if (key) accounts.add(key);
}

/** The accounts `text` names, in the order they were set; hex matches case-insensitively. */
function accountsIn(text: string): string[] {
  const lower = text.toLowerCase();
  const found: string[] = [];
  for (const key of accounts) {
    if ((/^[0-9a-f]+$/.test(key) ? lower : text).includes(key)) found.push(key);
  }
  return found;
}

/**
 * Start an operation: until `end` runs, operation parties' requests share a
 * group that no other operation uses. Returns the operation's group key and
 * `end`. A second begin replaces the first.
 */
export function beginTorOperation(): { key: string; end: () => void } {
  const key = `operation:${++operations}`;
  operation = key;
  live.add(key);
  return { key, end: () => { live.delete(key); if (operation === key) operation = null; } };
}

/** Operations that have begun and not ended. */
const live = new Set<string>();

/** The operation in progress, if any. */
export function currentTorOperation(): string | null {
  return operation;
}

let subjects = 0;

/**
 * The operation that sent each recent operation request, by its text, so a
 * client's retry keeps to that operation however late it comes. Only the
 * latest SENT_KEPT are kept, far more than any retry overlaps.
 */
const sent = new Map<string, string>();
const SENT_KEPT = 512;

function sentBy(text: string): string | null {
  return sent.get(text) ?? null;
}

/**
 * The group that received each recent relayer quote, by the commitment the
 * relayer signed into it. A relay names its quote's commitment, and may be
 * sent long after the quote, once proving is done, by when its operation may
 * have ended, or the user switched accounts, and another begun. Only the
 * latest SENT_KEPT are kept.
 */
const quotes = new Map<string, string>();
/** An EVM quote's signed commitment, or a Sui quote's fee-commitment signature (opaque). */
const COMMITMENT = /"signedRelayerCommitment"\s*:\s*"(0x[0-9a-fA-F]+)"|"feeCommitment"\s*:\s*\{[^{}]*"signature"\s*:\s*"([^"]+)"/g;

/** Record the relayer commitments in a response that the group `key` received. */
export function noteTorQuotes(key: string, body: string): void {
  for (const [, evm, sui] of body.matchAll(COMMITMENT)) {
    const token = (evm ?? sui).toLowerCase();
    quotes.delete(token);
    quotes.set(token, key);
    if (quotes.size > SENT_KEPT) quotes.delete(quotes.keys().next().value!);
  }
}

/** The group that received the quote whose commitment `text` names, if any. */
function quotedBy(text: string): string | null {
  const lower = text.toLowerCase();
  for (const [token, key] of quotes) if (lower.includes(token)) return key;
  return null;
}

/**
 * The group key for a request to `party` whose URL and body are `text` and
 * whose `subject` is known beyond its text. A request that identifies the
 * user without naming an account or a transaction goes with the operation in
 * progress, or else to a group of its own.
 */
export function torGroupFor(party: TorParty, text: string, subject: TorSubject = {}): string {
  const signer = subject.account ? needle(subject.account) ?? subject.account : null;
  if (signer) return `account:${signer}`;
  const [named] = accountsIn(text);
  if (named) return `account:${named}`;
  if (subject.transaction) return `tx:${transactionKey(subject.transaction)}`;
  if (subject.identifying || OPERATION_PARTIES.has(party)) {
    // A relay goes with the operation that fetched its quote while that
    // operation lasts, and after it ends over a group of its own: never the
    // public group or a later operation.
    const quoted = quotedBy(text);
    if (quoted) return live.has(quoted) ? quoted : `subject:${++subjects}`;
    // A client that retries sends the same request again, possibly after its
    // operation ended and the next began: it goes over a group of its own.
    const earlier = sentBy(text);
    if (earlier && earlier !== operation) return `subject:${++subjects}`;
    if (operation) {
      sent.delete(text);
      sent.set(text, operation);
      if (sent.size > SENT_KEPT) sent.delete(sent.keys().next().value!);
      return operation;
    }
  }
  // A relayer or LI.FI request with a body (a quote or a relay) describes a
  // transaction the user is making, even outside an operation.
  if (subject.identifying || (OPERATION_PARTIES.has(party) && /\n./.test(text))) {
    return `subject:${++subjects}`;
  }
  if (party === 'relayer') return 'public:asp';
  if (party === 'lifi') return 'public:web';
  return `public:${party}`;
}

/** A transaction hash in one spelling: hex in lower case without `0x`, any other kind as given. */
function transactionKey(transaction: string): string {
  const hex = /^(0x)?([0-9a-fA-F]{64})$/.exec(transaction);
  return hex ? hex[2].toLowerCase() : transaction;
}

/** EVM methods that ask about one transaction by its hash. */
const TRANSACTION_LOOKUPS = new Set(['eth_getTransactionReceipt', 'eth_getTransactionByHash']);

/**
 * What an EVM JSON-RPC body is about: the transaction it sends (by the hash
 * of the signed bytes) or looks up. A batch about two transactions would link
 * them on one group, so it identifies the user instead and gets a group of
 * its own.
 */
export function rpcSubject(body: string | null | undefined): TorSubject {
  if (!body) return {};
  let calls: unknown[];
  try {
    const parsed = JSON.parse(body) as unknown;
    calls = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return {};
  }
  const transactions = new Set<string>();
  for (const call of calls) {
    const { method, params } = (call ?? {}) as { method?: unknown; params?: unknown };
    const first = Array.isArray(params) ? params[0] : undefined;
    if (typeof first !== 'string') continue;
    if (TRANSACTION_LOOKUPS.has(method as string)) transactions.add(transactionKey(first));
    else if (method === 'eth_sendRawTransaction' && isHex(first)) transactions.add(transactionKey(keccak256(first)));
  }
  if (transactions.size > 1) return { identifying: true };
  const [transaction] = transactions;
  return transaction ? { transaction } : {};
}

/** A LI.FI status query is about the transaction it names; any other call is the operation's. */
export function lifiStatusSubject(url: string): TorSubject {
  if (!url.includes('/v1/status')) return {};
  const transaction = /[?&]txHash=([^&#]+)/.exec(url)?.[1];
  return transaction ? { transaction: decodeURIComponent(transaction) } : { identifying: true };
}
