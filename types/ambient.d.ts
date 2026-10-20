// Ambient declarations for modules used by worker entrypoints that
// don't ship types (or aren't installed as a top-level dependency in
// package.json — they get bundled by esbuild at worker build time).

declare module 'snarkjs' {
  // We don't need the real type; only the few exports the workers
  // reach for. Cast to `any` to keep this tiny.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const groth16: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const wtns: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const plonk: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const fflonk: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const zKey: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type Groth16Proof = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type PublicSignals = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _default: any;
  export default _default;
}

declare module '@vercel/node' {
  // /api/* serverless functions get the request/response types from
  // Vercel at runtime; we only need a structural fit for typechecks.
  export interface VercelRequest {
    method?: string;
    headers: Record<string, string | string[] | undefined>;
    query: Record<string, string | string[] | undefined>;
    body: Record<string, unknown> & Partial<Record<string, string>>;
  }
  export interface VercelResponse {
    status(code: number): VercelResponse;
    json(value: unknown): VercelResponse;
    send(value: unknown): VercelResponse;
    end(value?: unknown): VercelResponse;
    setHeader(key: string, value: string | string[]): VercelResponse;
  }
}

// Bun globals used by check-web.ts — the actual runtime is bun, but
// the tsc that runs over the repo doesn't include @types/bun.
declare const Bun: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  WebView: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  write(path: string, data: unknown): any;
  file(path: string): { text(): Promise<string> };
};
