/**
 * A TTL cache with one slot PER SCOPE.
 *
 * Extracted so it can actually be tested: its only consumer
 * (services/price-service.ts) reaches config/tokens and therefore cannot be
 * imported by a bun test at all (react-native blows up on load). A cache bug
 * hiding behind an untestable module is how the single-slot version survived.
 *
 * The bug it replaces: one slot holding its own scope and missing whenever the
 * scope differed, so a chain-scoped caller and an unscoped one evicted each
 * other on every call. Five screens asking for prices produced five requests,
 * and WHICH ones went out depended on the order the user opened things in —
 * wasteful, and a small statement about navigation. It matters more with a
 * scheduler keeping one scope warm on a fixed cadence, because the periodic
 * scoped fetch and the screens' unscoped ones would thrash forever.
 *
 * Deliberately not an LRU: the scope set is the chains a build serves plus the
 * unscoped entry, so it is small and bounded by configuration rather than by
 * anything a user does.
 */

type Entry<T> = { value: T; at: number };

export class ScopedTtlCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** `undefined` is a real scope (a cross-chain answer), not a miss. */
  static key(scope: string | undefined): string {
    return scope ?? '*';
  }

  get(scope: string | undefined): T | undefined {
    const entry = this.entries.get(ScopedTtlCache.key(scope));
    if (!entry) return undefined;
    // A clock that jumped backwards makes `age` negative, which must read as
    // fresh rather than as an overflowed miss.
    if (this.now() - entry.at >= this.ttlMs) {
      this.entries.delete(ScopedTtlCache.key(scope));
      return undefined;
    }
    return entry.value;
  }

  set(scope: string | undefined, value: T): void {
    this.entries.set(ScopedTtlCache.key(scope), { value, at: this.now() });
  }

  delete(scope: string | undefined): void {
    this.entries.delete(ScopedTtlCache.key(scope));
  }

  clear(): void {
    this.entries.clear();
  }

  /** Live scopes, for tests and diagnostics. Expired entries are not pruned eagerly. */
  size(): number {
    return this.entries.size;
  }
}
