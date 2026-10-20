/**
 * Positive on-chain confirmation for direct Sui writes (codex round 3).
 *
 * dapp-kit's signAndExecuteTransaction resolves with a digest even when the
 * Move call ABORTED — execution status lives in the transaction effects.
 * Every hook that marks success (and mutates local note state) from the
 * digest alone therefore fabricated phantom deposits / locally spent real
 * notes on Move aborts. Call this after every execute and only proceed on
 * an explicit 'success'.
 */
type SuiClientLike = {
  waitForTransaction: (params: {
    digest: string;
    options?: { showEffects?: boolean };
  }) => Promise<{ effects?: { status?: { status?: string; error?: string } } | null } | null>;
};

export async function requireSuiTxSuccess(
  client: SuiClientLike,
  digest: string,
  label: string,
): Promise<void> {
  const res = await client.waitForTransaction({ digest, options: { showEffects: true } });
  const status = res?.effects?.status?.status;
  if (status !== 'success') {
    const detail = res?.effects?.status?.error;
    throw new Error(`${label} failed on-chain${detail ? `: ${detail}` : ''} (tx ${digest}). Local state was not changed.`);
  }
}
