declare module 'bun:test' {
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: () => void | Promise<void>, timeout?: number): void;

  type Hook = (fn: () => void | Promise<void>, timeout?: number) => void;
  export const beforeAll: Hook;
  export const beforeEach: Hook;
  export const afterAll: Hook;
  export const afterEach: Hook;

  export interface Expectation {
    not: Expectation;
    toBe(value: unknown): void;
    toBeNull(): void;
    toBeDefined(): void;
    toBeUndefined(): void;
    toBeCloseTo(value: number, numDigits?: number): void;
    toEqual(value: unknown): void;
    toMatch(value: string | RegExp): void;
    toBeTruthy(): void;
    toMatchObject(value: unknown): void;
    toThrow(expected?: string | RegExp): void;
    toContain(value: unknown): void;
    toContainEqual(value: unknown): void;
    toHaveLength(length: number): void;
    toBeGreaterThan(value: number | bigint): void;
    toBeGreaterThanOrEqual(value: number | bigint): void;
    toBeLessThan(value: number | bigint): void;
    toBeLessThanOrEqual(value: number | bigint): void;
    toBeInstanceOf(ctor: unknown): void;
    toHaveBeenCalledTimes(count: number): void;
    rejects: Expectation;
  }

  export function expect(value: unknown): Expectation;

  /** A `mock()`-wrapped function, carrying call bookkeeping. */
  export type Mock<T extends (...args: never[]) => unknown> = T & {
    mock: { calls: Parameters<T>[] };
  };

  /**
   * `mock(fn)` wraps a function with call bookkeeping; `mock.module(...)`
   * replaces the module registry entry for `specifier`.
   */
  export const mock: (<T extends (...args: never[]) => unknown>(fn: T) => Mock<T>) & {
    module(specifier: string, factory: () => unknown): void;
  };
}
