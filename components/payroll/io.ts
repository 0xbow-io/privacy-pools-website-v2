// Payroll pure mapping helpers + web-only file download / pick helpers for
// import/export. The mapping helpers (buildRunItems / resolvePayrollTransferParams
// / applyMarkPaid) carry the run.tsx logic that was previously inline, so it can
// be unit-tested without the component; the download/pick helpers are no-ops off
// web.

import type { Employee, PayrollRun, PayrollRunItem } from '@/services/payroll-store';

// Chain/token resolution is INJECTED (type-only imports above keep this
// module bun-testable — a runtime import of payroll-store pulls
// config/chains → react-native into the module graph).
export type PayrollChainDeps = {
  /** displayName → chainId on this build; undefined = unknown network. */
  resolveChainId: (network: string) => number | undefined;
  /** Registry metadata for `symbol` on `chainId`; undefined = unsupported. */
  getToken: (symbol: string, chainId: number) => { decimals: number } | undefined;
};

// The token symbols the pools (and the transfer modal) support. Payroll-local:
// config/tokens has no symbol-list constant on this branch, and the transfer
// modal's prefill type is this exact union.
export const POOL_TOKEN_SYMBOLS = ['ETH', 'USDC', 'USDT'] as const;
export type PoolTokenSymbol = (typeof POOL_TOKEN_SYMBOLS)[number];

/**
 * Executable decimal string for an amount that may only exist as a JS number
 * (legacy rows). Never emits exponent notation — the transfer parser accepts
 * only plain decimals, and a later sanitizer would mangle "1e-7" into "17".
 */
export function safeDecimalString(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  const plain = String(n);
  if (!/e/i.test(plain)) return plain;
  // Expand exponent notation by MOVING THE DECIMAL POINT (codex: toFixed
  // re-emits exponent notation for magnitudes >= 1e21, and '1e+21' would be
  // mangled to '121' by the amount sanitizer).
  const match = plain.match(/^(\d+)(?:\.(\d+))?e([+-]\d+)$/i);
  if (!match) return '0';
  const [, intPart, fracPart = '', expStr] = match;
  const exp = Number(expStr);
  const digits = intPart + fracPart;
  const pointIndex = intPart.length + exp;
  if (pointIndex <= 0) {
    return `0.${'0'.repeat(-pointIndex)}${digits}`.replace(/0+$/, '').replace(/\.$/, '');
  }
  if (pointIndex >= digits.length) {
    return digits + '0'.repeat(pointIndex - digits.length);
  }
  return `${digits.slice(0, pointIndex)}.${digits.slice(pointIndex)}`.replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Map the team to pending run items. Only 'active' employees are included —
 * onboarding / paused members are never auto-added to a run. Each item
 * carries its own execution context (chainId + exact amount text): payroll
 * rows must never be silently re-routed to whatever chain happens to be
 * active at pay time (codex round 3).
 */
export function buildRunItems(employees: Employee[], resolveChainId?: PayrollChainDeps['resolveChainId']): PayrollRunItem[] {
  return employees
    .filter((e) => e.status === 'active')
    .map((e) => ({
      employeeId: e.id,
      name: e.name,
      walletAddress: e.walletAddress,
      network: e.network,
      chainId: resolveChainId?.(e.network),
      amount: e.salary,
      amountText: e.salaryText ?? safeDecimalString(e.salary),
      currency: e.currency,
      status: 'pending' as const,
    }));
}

/**
 * Resolve the transfer-modal params for paying one run item, or a REFUSAL
 * with a reason. The old version silently substituted USDC for any currency
 * the pools "don't support" and stringified the amount via String(number) —
 * an imported "DAI on Citrea" row would have paid USDC on whatever chain was
 * active (codex round 3). Now: the currency must exist on the ITEM's chain
 * registry, and the amount must be an exact plain-decimal string.
 */
export function resolvePayrollTransferParams(item: PayrollRunItem, deps: PayrollChainDeps): {
  recipient: string;
  amount: string;
  tokenSymbol: string;
} | { refusal: string } {
  const chainId = item.chainId ?? deps.resolveChainId(item.network);
  if (chainId === undefined) {
    return { refusal: `Unknown network "${item.network}". Edit the employee's network before paying.` };
  }
  const token = deps.getToken(item.currency, chainId);
  if (!token) {
    return { refusal: `${item.currency} is not available on ${item.network}. Edit the employee's currency before paying.` };
  }
  const amount = item.amountText ?? safeDecimalString(item.amount);
  if (!/^\d+(\.\d+)?$/.test(amount) || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    return { refusal: 'This row has an invalid amount. Edit the employee\'s salary before paying.' };
  }
  // The amount must be representable in the TOKEN's precision (codex): a
  // 7-decimal USDC amount silently rounds at parseUnits (0.0000001 USDC → 0
  // base units), so the executed amount would not be the stored one.
  const frac = amount.split('.')[1] ?? '';
  if (frac.length > token.decimals) {
    return { refusal: `${item.currency} supports ${token.decimals} decimal places. Edit the salary (${amount} has ${frac.length}).` };
  }
  return { recipient: item.walletAddress, amount, tokenSymbol: item.currency };
}

/**
 * Compute the run patch for marking one employee's item paid: only the matching
 * item flips to 'paid' (stamping txHash), an already-paid item is never
 * reverted, and the run is promoted to 'confirmed' only once every item is paid.
 * Pure — the caller reads the latest run from the store and persists the result.
 */
export function applyMarkPaid(
  run: PayrollRun,
  employeeId: string,
  txHash?: string,
): { items: PayrollRunItem[]; status: PayrollRun['status'] } {
  const items = run.items.map((it) =>
    it.employeeId === employeeId ? { ...it, status: 'paid' as const, txHash: txHash ?? it.txHash } : it,
  );
  const allPaid = items.every((it) => it.status === 'paid');
  return { items, status: allPaid ? 'confirmed' : run.status };
}

// A spreadsheet-friendly history report: one row per payment (run × recipient),
// distinct from the JSON backup export (which round-trips through Settings →
// Import). Amounts stay raw numeric — no symbol, no thousands separator — so a
// sheet can sort and sum them; the currency lives in its own column.
const RUNS_CSV_HEADER = 'Period,Date,Payee,Wallet,Network,Amount,Currency,Status,Tx Hash';

// Quote a cell only when it contains a comma, quote, or newline, doubling any
// embedded quotes (RFC 4180) — the same rule the accounting export uses.
function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildRunsCsv(runs: PayrollRun[]): string {
  const rows: string[] = [];
  for (const run of runs) {
    const date = new Date(run.date).toISOString().slice(0, 10);
    for (const it of run.items) {
      rows.push(
        [run.periodLabel, date, it.name, it.walletAddress, it.network,
          String(it.amount), it.currency, it.status, it.txHash ?? '']
          .map((c) => csvCell(String(c))).join(','),
      );
    }
  }
  return [RUNS_CSV_HEADER, ...rows].join('\n');
}

export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function pickTextFile(): Promise<string | null> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') { resolve(null); return; }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json,.csv,text/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    };
    input.click();
  });
}
