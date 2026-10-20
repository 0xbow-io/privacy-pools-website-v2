/**
 * Move-abort decoder for the Privacy Pools V2 Sui contracts.
 *
 * On-chain `assert!(cond, CODE)` failures reach the wallet/relayer as an opaque
 * `MoveAbort(MoveLocation { ... name: Identifier("<module>") ... }, <code>)`
 * string. Without a decoder the user only sees a bare number (e.g. `659` ->
 * really `66` once the Move VM sub-status is stripped, or `30`), which is
 * meaningless. This module maps the `const E_* : u64` abort codes declared in
 * `ppv2-sui-v2-sync/sources/*.move` to their names + a human-readable message,
 * keyed per module (codes are NOT globally unique — e.g. 32 = E_ZERO_COMMITMENT
 * in pool AND keystore; 43 = E_ZERO_ROOT in asp_registry AND root_buffer).
 *
 * Source of truth (abort codes read verbatim, 2026-06):
 *   sources/pool.move, sources/keystore.move, sources/entrypoint.move,
 *   sources/asp_registry.move, sources/relay.move, sources/lean_imt.move,
 *   sources/root_buffer.move
 *
 * IMPORTANT: keep these tables byte-for-byte in sync with the Move sources. A
 * drift here mislabels an on-chain abort.
 */

export interface DecodedAbort {
  /** Module the abort originated in (e.g. `pool`), when parseable. */
  module: string | null;
  /** Numeric abort code (the Move `assert!` code), when parseable. */
  code: number | null;
  /** Symbolic name, e.g. `E_GVK_MISMATCH` (null when unknown). */
  name: string | null;
  /** Human-readable, user-facing message. */
  message: string;
}

interface CodeEntry {
  name: string;
  message: string;
}

/**
 * Per-module abort-code tables. Each maps `code -> { name, message }`.
 * Mirrors the `const E_* : u64 = N;` declarations in the matching `.move` file.
 */
const POOL: Record<number, CodeEntry> = {
  1: { name: 'E_NOT_AUTHORIZED', message: 'Not authorized for this action.' },
  2: { name: 'E_CAP_REVOKED', message: 'This capability has been revoked.' },
  3: { name: 'E_CAP_POOL_MISMATCH', message: 'Capability does not belong to this pool.' },
  4: { name: 'E_NO_BALANCE_FOR_TOKEN', message: 'The pool holds no balance for this token type.' },
  10: { name: 'E_PAUSED', message: 'The pool is paused.' },
  11: { name: 'E_NOT_PAUSED', message: 'The pool is not paused.' },
  20: { name: 'E_INVALID_PROOF', message: 'The zero-knowledge proof is invalid (proof or public inputs do not verify on-chain).' },
  30: { name: 'E_NULLIFIER_ALREADY_SPENT', message: 'This note was already spent (nullifier already used).' },
  31: { name: 'E_COMMITMENT_ALREADY_EXISTS', message: 'A commitment with this value already exists in the state tree.' },
  32: { name: 'E_ZERO_COMMITMENT', message: 'Commitment cannot be zero.' },
  33: { name: 'E_COMMITMENT_NOT_FOUND', message: 'Commitment not found in the state tree.' },
  40: { name: 'E_UNKNOWN_STATE_ROOT', message: 'State root is not a known (recent) root.' },
  41: { name: 'E_UNKNOWN_KEYSTORE_ROOT', message: 'Keystore root is not a known (recent) root.' },
  42: { name: 'E_UNKNOWN_ASP_ROOT', message: 'ASP root is not a known root.' },
  50: { name: 'E_ZERO_AMOUNT', message: 'Amount cannot be zero.' },
  60: { name: 'E_VALUE_EXCEEDS_FIELD_ORDER', message: 'A value exceeds the BN254 field order.' },
  61: { name: 'E_INVALID_OWNER', message: 'Invalid owner address for this note.' },
  62: { name: 'E_INVALID_KEYSTORE', message: 'Invalid keystore object reference.' },
  63: { name: 'E_INVALID_ASP_REGISTRY', message: 'Invalid ASP registry object reference.' },
  64: { name: 'E_CANNOT_REVOKE_OWN_CAP', message: 'Cannot revoke your own capability.' },
  65: { name: 'E_TOKEN_TYPE_MISMATCH', message: 'Token type does not match the type registered for this tokenId.' },
  66: { name: 'E_INVALID_CIPHERTEXT', message: 'Invalid GVK ciphertext (wrong length, or non-empty on a GVK-disabled pool).' },
  67: { name: 'E_STATE_TREE_FULL', message: 'The state tree is full.' },
  68: { name: 'E_INVALID_MAX_TREE_SIZE', message: 'Invalid maximum tree size.' },
  69: { name: 'E_GVK_MISMATCH', message: 'The Global View Key bound by the proof does not match the on-chain pool GVK.' },
};

const KEYSTORE: Record<number, CodeEntry> = {
  32: { name: 'E_ZERO_COMMITMENT', message: 'Keystore commitment cannot be zero.' },
  60: { name: 'E_VALUE_EXCEEDS_FIELD_ORDER', message: 'A value exceeds the BN254 field order.' },
  70: { name: 'E_AUTH_POLICY_ALREADY_SET', message: 'An auth policy is already set for this account (already registered).' },
  71: { name: 'E_AUTH_POLICY_NOT_SET', message: 'No auth policy is set for this account; register one first.' },
  73: { name: 'E_INVALID_NULLIFYING_KEY_HASH', message: 'Invalid nullifying-key hash.' },
  74: { name: 'E_KEYSTORE_TREE_FULL', message: 'The keystore tree is full.' },
  75: { name: 'E_INVALID_MAX_TREE_SIZE', message: 'Invalid maximum keystore tree size.' },
  76: { name: 'E_CAP_KEYSTORE_MISMATCH', message: 'Capability does not belong to this keystore.' },
  77: { name: 'E_INVALID_LIVENESS', message: 'Invalid keystore-root liveness window.' },
};

const ENTRYPOINT: Record<number, CodeEntry> = {
  100: { name: 'E_ASSET_NOT_ENABLED', message: 'This asset is not enabled for deposits.' },
  101: { name: 'E_BELOW_MIN_AMOUNT', message: 'Deposit amount is below the configured minimum.' },
  102: { name: 'E_INVALID_FEE_BPS', message: 'Invalid fee (basis points out of range).' },
  103: { name: 'E_POOL_MISMATCH', message: 'Entrypoint is configured for a different pool.' },
  104: { name: 'E_INVALID_MIN_AMOUNT', message: 'Invalid minimum deposit amount.' },
};

const ASP_REGISTRY: Record<number, CodeEntry> = {
  43: { name: 'E_ZERO_ROOT', message: 'ASP root cannot be zero.' },
  44: { name: 'E_EMPTY_IPFS_CID', message: 'IPFS CID cannot be empty.' },
  45: { name: 'E_ROOT_OUT_OF_FIELD', message: 'ASP root exceeds the BN254 field order.' },
};

const RELAY: Record<number, CodeEntry> = {
  200: { name: 'E_ZERO_WITHDRAWAL', message: 'Withdrawal amount cannot be zero.' },
  201: { name: 'E_FEE_EXCEEDS_MAX', message: 'Relay fee exceeds the maximum allowed for this asset.' },
  202: { name: 'E_FEE_EXCEEDS_WITHDRAWAL', message: 'Relay fee exceeds the withdrawal amount.' },
  203: { name: 'E_INVALID_PAYOUT_DATA', message: 'Invalid payout routing data (must be 72 bytes).' },
  204: { name: 'E_POOL_MISMATCH', message: 'Relay config is for a different pool.' },
  205: { name: 'E_ENTRYPOINT_MISMATCH', message: 'Relay config is for a different entrypoint.' },
};

const LEAN_IMT: Record<number, CodeEntry> = {
  80: { name: 'E_TREE_FULL', message: 'The Merkle tree is full.' },
  82: { name: 'E_LEAF_INDEX_OUT_OF_BOUNDS', message: 'Leaf index is out of bounds.' },
};

const ROOT_BUFFER: Record<number, CodeEntry> = {
  43: { name: 'E_ZERO_ROOT', message: 'Root cannot be zero.' },
};

/** Module name (as it appears in the abort `Identifier("...")`) -> its table. */
const MODULE_TABLES: Record<string, Record<number, CodeEntry>> = {
  pool: POOL,
  keystore: KEYSTORE,
  entrypoint: ENTRYPOINT,
  asp_registry: ASP_REGISTRY,
  relay: RELAY,
  lean_imt: LEAN_IMT,
  root_buffer: ROOT_BUFFER,
};

/**
 * The Move VM can pack an extra sub-status into the high bits of the reported
 * abort code (the `<< 16` location/category encoding). The user-facing code we
 * declared is always the low 16 bits, so mask before lookup. A bare `30` masks
 * to `30`; a packed `659` (0x293) masks to `659` -> not a real code, but the
 * raw VM string can also surface `... }, 659)` where 659 is the literal
 * `assert!` code if the source used it. We therefore try the raw code first,
 * then the low-16-bit masked value.
 */
function candidateCodes(code: number): number[] {
  const masked = code & 0xffff;
  return masked === code ? [code] : [code, masked];
}

/** Parse the module name out of a MoveAbort string, if present. */
function parseModule(s: string): string | null {
  const m = /Identifier\("([a-z_]+)"\)/.exec(s);
  return m ? m[1] : null;
}

/**
 * Parse the abort code out of a MoveAbort string. The code is the last integer
 * argument of the abort: `MoveAbort(MoveLocation { ... }, <code>)`.
 */
function parseCode(s: string): number | null {
  // Prefer the `}, <code>)` tail form (the abort code argument).
  const tail = /\},\s*(\d+)\s*\)/.exec(s);
  if (tail) return Number(tail[1]);
  // Fallback: a bare trailing integer.
  const bare = /(\d+)\s*\)?\s*$/.exec(s.trim());
  return bare ? Number(bare[1]) : null;
}

/** Look a code up in a specific module's table (tries masked variants). */
function lookupInModule(
  table: Record<number, CodeEntry>,
  code: number,
): CodeEntry | null {
  for (const c of candidateCodes(code)) {
    if (table[c] !== undefined) return table[c];
  }
  return null;
}

/**
 * Decode a Move abort code (with optional module name) into a friendly entry.
 * When `module` is known, only that module's table is consulted (codes are not
 * globally unique). When `module` is unknown, every module table is scanned and
 * the first match wins (deterministic table order: pool first).
 */
export function decodeAbortCode(code: number, module?: string | null): DecodedAbort {
  if (module && MODULE_TABLES[module]) {
    const entry = lookupInModule(MODULE_TABLES[module], code);
    if (entry) {
      return { module, code, name: entry.name, message: entry.message };
    }
    return {
      module,
      code,
      name: null,
      message: `Unknown ${module} abort code ${code}.`,
    };
  }
  // Unknown module: scan all tables in a fixed order.
  for (const [mod, table] of Object.entries(MODULE_TABLES)) {
    const entry = lookupInModule(table, code);
    if (entry) {
      return { module: mod, code, name: entry.name, message: entry.message };
    }
  }
  return { module: module ?? null, code, name: null, message: `Unknown Move abort code ${code}.` };
}

/**
 * Decode a raw error string that MAY contain a `MoveAbort(...)`. If a Move abort
 * is found, returns a friendly `"<E_NAME>: <message> (module::code N)"` string.
 * If no Move abort is present, returns the original string unchanged (so
 * non-Move errors — network failures, validation, etc. — pass through verbatim).
 */
export function decodeAbortMessage(raw: string): string {
  if (typeof raw !== 'string' || !raw.includes('MoveAbort')) return raw;
  const module = parseModule(raw);
  const code = parseCode(raw);
  if (code == null) return raw;
  const decoded = decodeAbortCode(code, module);
  const loc = decoded.module ? `${decoded.module}::${decoded.code}` : `code ${decoded.code}`;
  if (decoded.name) {
    return `${decoded.name}: ${decoded.message} (${loc})`;
  }
  return `${decoded.message} (${loc})`;
}

/**
 * Convenience wrapper: take any thrown value and surface a decoded, friendly
 * message. Non-Move errors fall through to their original message. Use in the
 * Sui hooks' catch paths in place of `err.message`.
 */
export function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return decodeAbortMessage(raw);
}
