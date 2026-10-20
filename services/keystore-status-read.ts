/**
 * Which keys and address a per-chain keystore status read runs against, and
 * the one retry it gets (DEV-439).
 *
 * PURE (no react-native imports) so bun can pin it.
 *
 * The registration card reads every chain the moment the account unlocks. Keys
 * are ready at that point, but the pool session that used to be the only
 * source of them is committed seconds later (circuit artifacts, entrypoint).
 * Every read in that window answered 'unknown', which the card shows as
 * "Couldn't check - Retry" on every chain. The status read needs only the
 * keystore manager and the address, both known at unlock, so it falls back to
 * them.
 */

export type StatusIdentity<K> = { keystoreManager: K; address: string };

export function pickStatusIdentity<K>(
  committed: { keystoreManager?: K | null; address?: string | null } | null | undefined,
  derived: { keystoreManager: K | null; address: string | null | undefined },
): StatusIdentity<K> | null {
  if (committed?.keystoreManager && committed.address) {
    return { keystoreManager: committed.keystoreManager, address: committed.address };
  }
  if (derived.keystoreManager && derived.address) {
    return { keystoreManager: derived.keystoreManager, address: derived.address };
  }
  return null;
}

/**
 * Read once more after a short pause when the first answer is 'unknown' (a
 * failed RPC read). Four chains read at once on public endpoints fail some of
 * the time, and the row otherwise stays on Retry until pressed by hand.
 */
export async function readStatusWithRetry<T extends string>(
  read: () => Promise<T>,
  opts: { delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const first = await read();
  if (first !== 'unknown') return first;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  await sleep(opts.delayMs ?? 1_500);
  return read();
}

/**
 * Whether the unlocked keys were derived for `address`. `keysTarget` is the
 * provider's `<address>:<chainId>` pin, written when keys are committed.
 */
export function keysBelongTo(keysTarget: string | null | undefined, address: string | null | undefined): boolean {
  if (!keysTarget || !address) return false;
  return keysTarget.split(':')[0] === address.toLowerCase();
}
