/** Approximate display only: never a quote or an input to transaction math. */
export function estimatedUsdLabel(usd: number): string | null {
  if (!Number.isFinite(usd) || usd <= 0) return null;
  if (usd < 0.01) return '≈ <$0.01';
  return `≈ $${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
