import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { getSupportedChains } from '@/config/chains';
import { ACTIVE_ENVIRONMENT, ENVIRONMENTS } from '@/config/environments';
import { STAGING_CHAINS, STAGING_ENABLED } from '@/config/staging-deployments';
import { legacyMigratedKey, legacyRowsForEnvironment, payrollKey, type PayrollScope } from '@/services/payroll-scope';

// Local-only payroll data: employees, payroll runs (history) and settings.
// Everything lives in this device's storage (web localStorage / native
// SecureStore) and can be imported/exported as JSON — there is no backend.

// Legacy keys, shared by every environment and account. Read once for the
// migration below, never written again.
const EMP_KEY = 'ppv2_payroll_employees_v1';
const RUNS_KEY = 'ppv2_payroll_runs_v1';
const SETTINGS_KEY = 'ppv2_payroll_settings_v1';
// Scoped keys: environment + session identity (services/payroll-scope.ts).
const EMP_BASE = 'ppv2_payroll_employees_v2';
const RUNS_BASE = 'ppv2_payroll_runs_v2';
const SETTINGS_BASE = 'ppv2_payroll_settings_v2';

// Networks we actually support right now come from the chain config (Sepolia
// in test mode). The aspirational ones are shown as "soon" + disabled.
export function supportedNetworks(): string[] {
  // EVM only (codex): payroll pays via the EVM transfer modal — offering Sui
  // produced a network whose currencies and address format can never pass.
  return getSupportedChains().filter((c) => c.chainType === 'evm').map((c) => c.displayName);
}
/** chainId for a stored network display name; undefined = not on this build. */
export function networkChainId(displayName: string): number | undefined {
  return getSupportedChains().find((c) => c.chainType === 'evm' && c.displayName === displayName)?.id;
}
export function defaultNetwork(): string {
  return supportedNetworks()[0] ?? 'Sepolia';
}
export const SOON_NETWORKS = ['Ethereum', 'Base', 'Arbitrum', 'Optimism', 'Polygon'];
export type EmployeeStatus = 'active' | 'onboarding' | 'paused';
export type PayCurrency = 'USDC' | 'USDT' | 'ETH';

export interface Employee {
  id: string;
  name: string;
  role: string;
  walletAddress: string;
  network: string;
  salary: number;
  /** Canonical decimal string of the salary — the EXECUTABLE amount
   * (salary:number stays for display math only; String(number) can emit
   * exponent notation that the transfer parser rejects/mangles). */
  salaryText?: string;
  currency: string;
  status: EmployeeStatus;
  createdAt: number;
}

export interface PayrollRunItem {
  employeeId: string;
  name: string;
  walletAddress: string;
  network: string;
  /** Execution chain for THIS row (from the employee's network at run time). */
  chainId?: number;
  amount: number;
  /** Exact decimal amount string used for execution. */
  amountText?: string;
  currency: string;
  status: 'pending' | 'paid' | 'failed';
  txHash?: string;
}

export interface PayrollRun {
  id: string;
  date: number; // unix ms
  periodLabel: string; // e.g. "May 2026"
  items: PayrollRunItem[];
  status: 'pending' | 'confirmed' | 'failed';
  note?: string;
  /**
   * EVM chain the run's transactions were submitted on. Absent on legacy
   * rows (single-chain era) — links fall back to the active chain then.
   * Persisted so explorer links keep pointing at the RIGHT chain after the
   * user switches (staging serves two EVM chains).
   */
  chainId?: number;
}

export interface PayrollSettings {
  displayCurrency: 'USD' | 'EUR';
}

const DEFAULT_SETTINGS: PayrollSettings = { displayCurrency: 'USD' };

// --- storage primitives ---
function rawGet(key: string): string | null {
  if (Platform.OS === 'web') {
    try { return typeof localStorage === 'undefined' ? null : localStorage.getItem(key); } catch { return null; }
  }
  try { return SecureStore.getItem(key); } catch { return null; }
}
function rawSet(key: string, value: string): void {
  if (Platform.OS === 'web') {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, value); } catch { /* ignore */ }
    return;
  }
  try { SecureStore.setItem(key, value); } catch { /* ignore */ }
}

function parseArray<T>(raw: string | null): T[] {
  try { const v = raw ? JSON.parse(raw) : null; return Array.isArray(v) ? (v as T[]) : []; } catch { return []; }
}

// --- reactive in-memory cache (so React subscribers get stable snapshots) ---
type Snapshot = { employees: Employee[]; runs: PayrollRun[]; settings: PayrollSettings };
let scope: PayrollScope = { envId: ACTIVE_ENVIRONMENT.id, owner: null };
let cache: Snapshot | null = null;
const listeners = new Set<() => void>();

const EMPTY: Snapshot = { employees: [], runs: [], settings: DEFAULT_SETTINGS };

/**
 * The first identity to open payroll in an environment inherits the legacy
 * records made in THAT environment (by network/chain), once. Records made in
 * the other environment are never carried over.
 */
function migrateLegacy(target: PayrollScope): void {
  if (!target.owner) return;
  if (rawGet(payrollKey(EMP_BASE, target)) !== null || rawGet(payrollKey(RUNS_BASE, target)) !== null) return;
  const marker = legacyMigratedKey(target.envId);
  if (rawGet(marker) !== null) return;
  const legacyEmployees = parseArray<Employee>(rawGet(EMP_KEY));
  const legacyRuns = parseArray<PayrollRun>(rawGet(RUNS_KEY));
  rawSet(marker, target.owner.toLowerCase());
  // Settings carry no chain, so they come along even with no rows to move.
  const legacySettings = rawGet(SETTINGS_KEY);
  if (legacySettings !== null) rawSet(payrollKey(SETTINGS_BASE, target), legacySettings);
  if (legacyEmployees.length === 0 && legacyRuns.length === 0) return;
  const otherEnv = ENVIRONMENTS[ACTIVE_ENVIRONMENT.id === 'prod' ? 'staging' : 'prod'];
  const otherNames = new Set(otherEnv.deployments.map((d) => d.displayName));
  const otherChains = new Set(otherEnv.deployments.map((d) => d.chainId));
  if (otherEnv.includesBaseChain && otherEnv.baseEvmChainId !== undefined) {
    otherChains.add(otherEnv.baseEvmChainId);
    otherNames.add('Sepolia');
  }
  // The whole staging world counts as "here", not only what this load shows:
  // plain staging hides the Ethereum, OP and Base pools that staging-mainnet
  // serves under the same scope, and the marker above is set only once.
  const stagingWorld = ACTIVE_ENVIRONMENT.id === 'staging' && STAGING_ENABLED ? STAGING_CHAINS : [];
  const worldNames = new Set(stagingWorld.map((d) => d.displayName));
  const worldChains = new Set(stagingWorld.map((d) => d.chainId));
  const kept = legacyRowsForEnvironment(
    legacyEmployees,
    legacyRuns,
    {
      network: (name) => networkChainId(name) !== undefined || worldNames.has(name),
      chain: (id) => worldChains.has(id) || getSupportedChains().some((c) => c.chainType === 'evm' && c.id === id),
    },
    { network: (name) => otherNames.has(name), chain: (id) => otherChains.has(id) },
    ACTIVE_ENVIRONMENT.id === 'prod',
  );
  rawSet(payrollKey(EMP_BASE, target), JSON.stringify(kept.employees));
  rawSet(payrollKey(RUNS_BASE, target), JSON.stringify(kept.runs));
}

function load(): Snapshot {
  // No identity yet: nothing to show, and nothing can be written (below).
  if (!scope.owner) return EMPTY;
  migrateLegacy(scope);
  const settingsRaw = rawGet(payrollKey(SETTINGS_BASE, scope));
  let settings = DEFAULT_SETTINGS;
  try { if (settingsRaw) settings = { ...DEFAULT_SETTINGS, ...JSON.parse(settingsRaw) }; } catch { /* default */ }
  return {
    employees: parseArray<Employee>(rawGet(payrollKey(EMP_BASE, scope))).sort((a, b) => a.createdAt - b.createdAt),
    runs: parseArray<PayrollRun>(rawGet(payrollKey(RUNS_BASE, scope))).sort((a, b) => b.date - a.date),
    settings,
  };
}

/**
 * Snapshot for the session identity (sessionAddress ?? wallet). Switching
 * identity switches the whole store; the previous identity's records are
 * never returned for the new one.
 */
export function getSnapshotFor(owner: string | null | undefined): Snapshot {
  const next = owner ? owner.toLowerCase() : null;
  if (next !== scope.owner) {
    scope = { envId: ACTIVE_ENVIRONMENT.id, owner: next };
    cache = null;
  }
  return getSnapshot();
}

export function getSnapshot(): Snapshot {
  if (!cache) cache = load();
  return cache;
}

function writable(): boolean {
  return !!scope.owner;
}
export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
function refresh() { cache = load(); listeners.forEach((l) => l()); }

// --- employees ---
export function saveEmployees(list: Employee[]): void {
  if (!writable()) return;
  rawSet(payrollKey(EMP_BASE, scope), JSON.stringify(list));
  refresh();
}
export function upsertEmployee(emp: Employee): void {
  const list = getSnapshot().employees.slice();
  const i = list.findIndex((e) => e.id === emp.id);
  if (i >= 0) list[i] = emp; else list.push(emp);
  saveEmployees(list);
}
export function deleteEmployee(id: string): void {
  saveEmployees(getSnapshot().employees.filter((e) => e.id !== id));
}

// --- runs (history) ---
export function saveRuns(list: PayrollRun[]): void {
  if (!writable()) return;
  rawSet(payrollKey(RUNS_BASE, scope), JSON.stringify(list));
  refresh();
}
export function addRun(run: PayrollRun): void {
  saveRuns([run, ...getSnapshot().runs]);
}
export function updateRun(id: string, patch: Partial<PayrollRun>): void {
  saveRuns(getSnapshot().runs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
}
export function deleteRun(id: string): void {
  saveRuns(getSnapshot().runs.filter((r) => r.id !== id));
}

// --- settings ---
export function saveSettings(patch: Partial<PayrollSettings>): void {
  if (!writable()) return;
  const next = { ...getSnapshot().settings, ...patch };
  rawSet(payrollKey(SETTINGS_BASE, scope), JSON.stringify(next));
  refresh();
}

// --- ids ---
export function newId(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// --- import / export ---
const EXPORT_KIND = 'ppv2-payroll-export';

export function exportEmployees(): string {
  return JSON.stringify({ kind: EXPORT_KIND, part: 'employees', version: 1, employees: getSnapshot().employees }, null, 2);
}
export function exportRuns(): string {
  return JSON.stringify({ kind: EXPORT_KIND, part: 'runs', version: 1, runs: getSnapshot().runs }, null, 2);
}
export function exportAll(): string {
  const s = getSnapshot();
  return JSON.stringify({ kind: EXPORT_KIND, part: 'all', version: 1, employees: s.employees, runs: s.runs, settings: s.settings }, null, 2);
}

export type ImportMode = 'merge' | 'replace';
export interface ImportResult { employees: number; runs: number; settings: boolean; }

// Coerce/validate untrusted imported records so a malformed file can never
// persist data that later crashes a render (e.g. a non-number salary).
function num(v: unknown, fallback: number): number { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function str(v: unknown, fallback = ''): string { return typeof v === 'string' ? v : fallback; }

function coerceEmployee(e: unknown): Employee | null {
  if (!e || typeof e !== 'object') return null;
  const o = e as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.name !== 'string') return null;
  const status = (['active', 'onboarding', 'paused'] as const).find((s) => s === o.status) ?? 'active';
  return {
    id: o.id, name: o.name, role: str(o.role), walletAddress: str(o.walletAddress),
    network: str(o.network, 'Ethereum'), salary: num(o.salary, 0),
    salaryText: typeof o.salaryText === 'string' && /^\d+(\.\d+)?$/.test(o.salaryText) ? o.salaryText : undefined,
    currency: str(o.currency, 'USDC'),
    status, createdAt: num(o.createdAt, Date.now()),
  };
}
function coerceRunItem(it: unknown): PayrollRunItem | null {
  if (!it || typeof it !== 'object') return null;
  const o = it as Record<string, unknown>;
  if (typeof o.employeeId !== 'string') return null;
  const status = (['pending', 'paid', 'failed'] as const).find((s) => s === o.status) ?? 'pending';
  return {
    employeeId: o.employeeId, name: str(o.name), walletAddress: str(o.walletAddress),
    network: str(o.network, 'Ethereum'),
    chainId: typeof o.chainId === 'number' && Number.isFinite(o.chainId) ? o.chainId : undefined,
    amount: num(o.amount, 0),
    amountText: typeof o.amountText === 'string' && /^\d+(\.\d+)?$/.test(o.amountText) ? o.amountText : undefined,
    currency: str(o.currency, 'USDC'),
    status, txHash: typeof o.txHash === 'string' ? o.txHash : undefined,
  };
}
function coerceRun(r: unknown): PayrollRun | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  if (typeof o.id !== 'string') return null;
  const status = (['pending', 'confirmed', 'failed'] as const).find((s) => s === o.status) ?? 'confirmed';
  const items = Array.isArray(o.items) ? o.items.map(coerceRunItem).filter((x): x is PayrollRunItem => !!x) : [];
  return {
    id: o.id, date: num(o.date, Date.now()), periodLabel: str(o.periodLabel), items, status,
    note: typeof o.note === 'string' ? o.note : undefined,
    // Legacy rows have no chainId — leave undefined (links fall back to the
    // active chain) rather than pinning them to whatever chain is current.
    chainId: typeof o.chainId === 'number' && Number.isFinite(o.chainId) ? o.chainId : undefined,
  };
}

export function importData(json: string, mode: ImportMode): ImportResult {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object') throw new Error('Not a valid payroll export.');
  const res: ImportResult = { employees: 0, runs: 0, settings: false };

  if (Array.isArray(parsed.employees)) {
    const incoming = parsed.employees.map(coerceEmployee).filter((e): e is Employee => !!e);
    if (mode === 'replace') saveEmployees(incoming);
    else {
      const byId = new Map(getSnapshot().employees.map((e) => [e.id, e] as const));
      for (const e of incoming) byId.set(e.id, e);
      saveEmployees(Array.from(byId.values()));
    }
    res.employees = incoming.length;
  }
  if (Array.isArray(parsed.runs)) {
    const incoming = parsed.runs.map(coerceRun).filter((r): r is PayrollRun => !!r);
    if (mode === 'replace') saveRuns(incoming);
    else {
      const byId = new Map(getSnapshot().runs.map((r) => [r.id, r] as const));
      for (const r of incoming) byId.set(r.id, r);
      saveRuns(Array.from(byId.values()).sort((a, b) => b.date - a.date));
    }
    res.runs = incoming.length;
  }
  if (parsed.settings && typeof parsed.settings === 'object') {
    const s = parsed.settings as Record<string, unknown>;
    if (s.displayCurrency === 'USD' || s.displayCurrency === 'EUR') { saveSettings({ displayCurrency: s.displayCurrency }); res.settings = true; }
  }
  if (res.employees === 0 && res.runs === 0 && !res.settings) throw new Error('No payroll records found in that file.');
  return res;
}

export function clearAllPayrollData(): void {
  saveEmployees([]);
  saveRuns([]);
  saveSettings(DEFAULT_SETTINGS);
}
