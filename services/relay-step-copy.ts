/**
 * What a relayed claim (the /import-note "Claim" of a one-time link) tells the
 * user when it fails, and which progress line it shows while it runs (DEV-494).
 *
 * Mike's run on 2026-10-02 (prod Ethereum, $5 USDC link): the claim sat on
 * "Generating proof" for minutes while the SDK was really waiting on the
 * relayer, then printed the raw block-walk timeout. On chain, the relayer's
 * signer burned that nonce (115) on a 0-value self-transfer at 12:56:23 UTC,
 * i.e. it cancelled its own stuck relay, and the retry landed as nonce 116.
 *
 * "Nothing was spent" is only said when it is provable. A relayer 4xx alone is
 * not proof: its failWrite turns a failed or timed-out broadcast into a 400 as
 * well (DEV-459). So, as in services/swap-error-copy.ts, only answers the
 * relayer gives BEFORE it signs count: a simulation revert, its gas-cap
 * refusal, an expired fee commitment, and its 503 for its own empty wallet.
 *
 * PURE so bun pins the rules.
 */
import { isRelayerOutOfGas, isRelayerRateLimited } from '@/services/transfer-outcome';

export const CLAIM_PROVING = 'Generating proof…';
// No "relay"/"submit" word is needed for the rail: FlowProgress maps
// "waiting for the relayer" to Submit and "waiting for the block" to Confirm.
export const RELAY_WAITING_RELAYER = 'Waiting for the relayer…';
export const RELAY_WAITING_BLOCK = 'Waiting for the block…';

/** The relayer interactor methods a claim relays through. */
export function isClaimRelayMethod(method: string | null): boolean {
  return method === 'relayWithdrawal' || method === 'relayRegisterAndWithdrawal';
}

const PRE_BROADCAST_REFUSAL = [
  // The body is JSON, so the quotes around the function name arrive escaped.
  /The contract function \\?"[^"\\]+\\?" reverted/,
  /estimated gas \d+ exceeds the relayer's cap/,
  /fee commitment has expired/i,
  /FeeCommitmentExpired/,
];

const SAVED = 'Your payment is still saved on this device.';

/**
 * User-facing copy for a failed relayed claim, or null to keep the existing
 * wording (an unrecognised error is still information).
 */
export function claimRelayFailureText(err: unknown): string | null {
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);

  // The relayer answered with a hash, then the transaction never showed up in
  // a block within the wait. It may still land, or the relayer may have
  // dropped it. Not provable either way, so never "nothing was spent".
  if (name === 'RelayedReceiptTimeout' || /Relayed transaction was not observed in any block/.test(message)) {
    return `The relayer took the claim but it has not landed yet. It may still land, so check your balance before you claim again. ${SAVED}`;
  }
  if (isRelayerOutOfGas(message) || /relayer's wallet cannot cover gas/i.test(message)) {
    return `The relayer cannot pay for gas on this network right now, so the claim was not sent and nothing was spent. ${SAVED} Try again later.`;
  }
  // Only the relayer interactor's own answer: a 429 from anywhere else says
  // nothing about whether the claim went out.
  if (name === 'RelayerRejected' && isRelayerRateLimited(message)) {
    return `The relayer is busy right now, so the claim was not sent and nothing was spent. ${SAVED} Wait a minute and try again.`;
  }
  if (name === 'RelayerRejected' && /^HTTP 4\d\d\b/.test(message) && PRE_BROADCAST_REFUSAL.some((re) => re.test(message))) {
    return `The relayer could not send the claim, so nothing was spent. ${SAVED} Try again.`;
  }
  return null;
}

/**
 * The refusal shown when the relayer's fee is larger than the payment. Only
 * reached from the quote, before any proof or relay, so "nothing was sent" is
 * true by construction.
 */
export const CLAIM_FEE_EXCEEDS_PAYMENT =
  'The network fee right now is more than this payment, so the relayer cannot claim it for you. Nothing was sent. '
  + `${SAVED} Retry when fees are lower, or add a little gas to this wallet.`;

/**
 * How long to wait before the second, fresh quote that has to agree before a
 * claim is refused for its fee. The relayer prices off eth_gasPrice at the
 * moment of the call, so one quote at a busy block is not the answer for the
 * next one (Mike: refused, then claimed minutes later at the same gas).
 */
export const CLAIM_FEE_REQUOTE_DELAY_MS = 4_000;

/**
 * Refuse only when two quotes agree. `quote` throws the relayer's amount
 * rejection; `isTooSmall` recognises it. Anything else propagates untouched.
 */
export async function quoteWithFreshRetry<Q>(input: {
  quote: () => Promise<Q>;
  isTooSmall: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  delayMs?: number;
  onFirstRefusal?: (err: unknown) => void;
}): Promise<Q> {
  try {
    return await input.quote();
  } catch (first) {
    if (!input.isTooSmall(first)) throw first;
    input.onFirstRefusal?.(first);
    const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    await sleep(input.delayMs ?? CLAIM_FEE_REQUOTE_DELAY_MS);
    return input.quote();
  }
}
