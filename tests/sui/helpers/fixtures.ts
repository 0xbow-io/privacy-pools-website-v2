/**
 * Shared deterministic fixtures + fakes for the Sui web-app integration tests.
 *
 * Everything here is in-field, deterministic, and chain-free. The fakes mirror
 * exactly the boundary surfaces the ported code touches:
 *   - InMemoryStorage: stands in for browser localStorage (note-store).
 *   - FakeChainReader: implements the subset of SuiChainReader the reconstruct
 *     layer calls, returning canned LeavesInserted/keystore/object-field data.
 *   - makeFetch / hangingFetch: a programmable global.fetch for relay tests.
 */

// Deterministic, in-field test inputs (kept aligned with sui-witness-crosscheck.mjs).
export const FIX = {
  ownerField: 12345678901234567890n,
  tokenId: 9999n,
  value: 1_000_000n,
  noteSecret: 11111111111111n,
  depositSecret: 22222222222222n,
  nullifyingKey: 33333333333333n,
};

/** A minimal in-memory localStorage matching the Web Storage API surface used. */
export class InMemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
  key(i: number): string | null {
    return Array.from(this.map.keys())[i] ?? null;
  }
  get length(): number {
    return this.map.size;
  }
  /** Test-only: raw keys (to assert owner namespacing). */
  rawKeys(): string[] {
    return Array.from(this.map.keys());
  }
}

/** Install a fresh in-memory localStorage on globalThis; returns it. */
export function installLocalStorage(): InMemoryStorage {
  const store = new InMemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    value: store,
    configurable: true,
    writable: true,
  });
  return store;
}

/**
 * A fake chain reader implementing the methods the reconstruct layer calls. It
 * is structurally the SuiChainReader surface (duck-typed); the reconstruct
 * functions accept it because they only call these methods.
 */
export interface ReaderState {
  /** commitment -> on-chain stamped timestamp. */
  timestamps: Map<bigint, bigint>;
  /** full ordered state-leaf list (as reconstructStateLeaves would return). */
  stateLeaves: bigint[];
  /** full ordered keystore-leaf list. */
  keystoreLeaves: bigint[];
  /** live pool root_buffer (non-zero roots). */
  rootBuffer: bigint[];
  /** keystore current_root. */
  keystoreRoot: bigint;
  /** latest ASP root. */
  aspRoot: bigint;
  /** pool gvk_enabled. */
  gvkEnabled?: boolean;
  /** pool gvk coords. */
  gvk?: { x: bigint; y: bigint };
}

export function makeFakeReader(state: ReaderState) {
  return {
    async getCommitmentTimestamp(c: bigint): Promise<bigint> {
      const t = state.timestamps.get(c);
      if (t == null) throw new Error(`commitment ${c} not found on-chain (no timestamp)`);
      return t;
    },
    async reconstructStateLeaves(): Promise<bigint[]> {
      return state.stateLeaves;
    },
    async reconstructKeystoreLeaves(): Promise<bigint[]> {
      return state.keystoreLeaves;
    },
    async getPoolRootBuffer(): Promise<bigint[]> {
      return state.rootBuffer;
    },
    async getKeystoreCurrentRoot(): Promise<bigint> {
      return state.keystoreRoot;
    },
    async getLatestAspRoot(): Promise<bigint> {
      return state.aspRoot;
    },
    async getGvkEnabled(): Promise<boolean> {
      return state.gvkEnabled ?? true;
    },
    async getPoolGvk(): Promise<{ x: bigint; y: bigint }> {
      if (!state.gvk) throw new Error('no gvk');
      return state.gvk;
    },
  };
}

/** A signed-fee-commitment quote builder for relay tests (valid by default). */
export function makeQuote(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = {
    feeAmount: '1000',
    feeCommitment: {
      asset: '0x2::sui::SUI',
      feeAmount: '1000',
      expiresAt: Date.now() + 60_000,
      relayer: '0xrelayer',
      signature: '0xsig',
    },
  };
  const o = { ...base, ...overrides } as Record<string, unknown>;
  if ('feeCommitment' in overrides && overrides.feeCommitment !== undefined) {
    o.feeCommitment = overrides.feeCommitment as unknown;
  } else if (overrides.commitmentOverrides) {
    o.feeCommitment = {
      ...(base.feeCommitment as Record<string, unknown>),
      ...(overrides.commitmentOverrides as Record<string, unknown>),
    };
    delete (o as Record<string, unknown>).commitmentOverrides;
  }
  return o;
}
