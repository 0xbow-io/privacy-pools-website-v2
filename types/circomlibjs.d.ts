/**
 * Ambient type declarations for circomlibjs.
 *
 * circomlibjs ships no types. The Sui witness construction path uses it for
 * BN254 Poseidon hashing and BabyJubJub scalar mul (GVK encryption). These
 * declarations cover only the surface that path uses; the field-element objects
 * (`F.e` / `F.toObject`) are opaque, so they are typed loosely as `unknown`/
 * `bigint` boundaries. At runtime the bundler resolves the real module.
 */
declare module 'circomlibjs' {
  /** A circomlibjs field-element handle (opaque WASM-backed value). */
  export type FieldElement = unknown;

  export interface PoseidonField {
    e(x: bigint | number | string): FieldElement;
    toObject(x: FieldElement): bigint;
  }

  /** Poseidon hasher: callable over an array of field-coercible inputs. */
  export interface Poseidon {
    (inputs: (bigint | number | string | FieldElement)[]): FieldElement;
    F: PoseidonField;
  }

  export interface BabyJub {
    F: PoseidonField;
    mulPointEscalar(point: FieldElement[], scalar: bigint): FieldElement[];
  }

  export function buildPoseidon(): Promise<Poseidon>;
  export function buildBabyjub(): Promise<BabyJub>;
}
