// Payroll data is local-only, and it used to live under three fixed keys shared
// by every environment and every account on the device. A staging run paid on
// Sepolia then showed up on prod as "Paid 1 ETH" and as a run nobody could pay
// ("Unknown network Sepolia"), and a second account on the same browser saw the
// first one's team (QA 2026-09-24). Records are now keyed by environment AND
// by the session identity (sessionAddress ?? wallet, never wagmi alone).
//
// Pure: no react-native or config imports, so bun can test it.

export type PayrollScope = { envId: string; owner: string | null };

/**
 * Storage key for one payroll record kind in one scope. Dots, not colons:
 * native SecureStore only accepts alphanumerics, ".", "-" and "_".
 */
export function payrollKey(base: string, scope: PayrollScope): string {
  return `${base}.${scope.envId}.${scope.owner ? scope.owner.toLowerCase() : 'none'}`;
}

/** Marker recording that the legacy (unscoped) data was already handed to a scope in this environment. */
export function legacyMigratedKey(envId: string): string {
  return `ppv2_payroll_v1_migrated.${envId}`;
}

/** SecureStore's key alphabet, so a test can hold every key to it. */
export const SECURE_STORE_KEY = /^[A-Za-z0-9._-]+$/;

type LegacyEmployee = { network?: string };
type LegacyRun = { chainId?: number; items?: Array<{ network?: string }> };

export type LegacyServes = {
  network: (displayName: string) => boolean;
  chain: (chainId: number) => boolean;
};

/**
 * The legacy records that belong to the environment now running. Legacy rows
 * carry no record of where they were made, so a chain is only evidence when
 * one environment serves it: a Sepolia row is staging's, full stop. A chain
 * both environments serve (Ethereum, BSC) goes to the environment that owns
 * overlaps (prod, the public app) and never to the other, so no row is ever
 * copied into both. Everything else stays behind.
 */
export function legacyRowsForEnvironment<E extends LegacyEmployee, R extends LegacyRun>(
  employees: E[],
  runs: R[],
  here: LegacyServes,
  other: LegacyServes,
  ownsOverlap: boolean,
): { employees: E[]; runs: R[] } {
  const takeNetwork = (n: string) => here.network(n) && (ownsOverlap || !other.network(n));
  const takeChain = (id: number) => here.chain(id) && (ownsOverlap || !other.chain(id));
  return {
    employees: employees.filter((e) => !!e.network && takeNetwork(e.network)),
    runs: runs.filter((r) => {
      if (typeof r.chainId === 'number') return takeChain(r.chainId);
      const nets = (r.items ?? []).map((i) => i.network).filter((n): n is string => !!n);
      return nets.length > 0 && nets.every(takeNetwork);
    }),
  };
}
