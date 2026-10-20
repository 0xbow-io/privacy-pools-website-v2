// A relayer quote carries every amount twice: the top-level display fields and
// the SIGNED fee commitment the relay actually enforces. Every decision must
// read the signed copy, and the two must agree, or a relayer could show one fee
// and charge another (codex on 3f9b3b2: Review displayed and approved the
// top-level fee while Confirm sized everything from the signed one).

type QuoteAmounts = {
  feeAmount: string | number;
  amountSent: string | number;
  amountReceived: string | number;
  feeCommitment: { feeAmount: string | number; amountSent: string | number; amountReceived: string | number };
};

/** True when the top-level amounts equal the signed commitment's, all parseable. */
export function quoteMatchesSignedCommitment(quote: QuoteAmounts): boolean {
  try {
    const fc = quote.feeCommitment;
    return BigInt(quote.feeAmount) === BigInt(fc.feeAmount)
      && BigInt(quote.amountSent) === BigInt(fc.amountSent)
      && BigInt(quote.amountReceived) === BigInt(fc.amountReceived);
  } catch {
    return false;
  }
}
