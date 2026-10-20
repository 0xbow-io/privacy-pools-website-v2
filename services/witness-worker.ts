// Web Worker entrypoint that runs the SDK's WitnessPreparationService
// off the main thread. The witness build is what actually makes
// "Generating proof..." freeze the UI: per-input Poseidon hashes for
// nullifiers, output commitments, and merkle proofs across three trees
// (state ~20, keystore ~20, ASP ~20) — easily several seconds of pure
// JS BigInt math with no yields. snarkjs.fullProve already runs in its
// own worker; this one removes the freeze that happens BEFORE that.
//
// Protocol mirrors snarkjs-worker.ts: messages tagged with `id` and
// `type` (one of build{Deposit,DepositFor,Transact,Ragequit}Witness),
// replies are { id, ok: true, result } or { id, ok: false, error }.

// (Buffer polyfill is injected via esbuild banner — see
// scripts/build-witness-worker.mjs. Putting it inline here doesn't help:
// esbuild's IIFE output runs module inits in declaration order, and
// circomlibjs touches Buffer at module-load time, BEFORE the polyfill
// import would execute. The banner runs as the first line inside the
// IIFE, before any module init.)

import {
  CryptoService,
  PoseidonHashService,
  MerkleService,
  WitnessPreparationService,
  NoteComputationService,
} from "@privacy-pools-v2/sdk";
import type {
  BuildDepositWitnessInputs,
  BuildRagequitWitnessInputs,
  BuildTransactWitnessInputs,
  IWitnessPreparationService,
} from "@privacy-pools-v2/sdk";

type BuildKind =
  | "buildDepositWitness"
  | "buildTransactWitness"
  | "buildRagequitWitness";

type BuildMsg = {
  id: number;
  type: BuildKind;
  inputs: unknown;
};

let servicePromise: Promise<IWitnessPreparationService> | null = null;

function getService(): Promise<IWitnessPreparationService> {
  if (servicePromise) return servicePromise;
  servicePromise = (async () => {
    const hashService = await PoseidonHashService.create();
    const cryptoService = new CryptoService();
    const merkleService = new MerkleService({ hashService });
    const noteComputationService = new NoteComputationService({ hashService, cryptoService });
    return new WitnessPreparationService({ hashService, merkleService, noteComputationService });
  })();
  // A failed init (e.g. WebAssembly memory exhausted) must not be cached:
  // the next request tries again instead of failing for the life of the tab.
  servicePromise.catch(() => { servicePromise = null; });
  return servicePromise;
}

self.addEventListener("message", async (event: MessageEvent<BuildMsg>) => {
  const msg = event.data;
  try {
    const service = await getService();
    let result: unknown;
    switch (msg.type) {
      case "buildDepositWitness":
        result = await service.buildDepositWitness(msg.inputs as BuildDepositWitnessInputs);
        break;
      case "buildTransactWitness":
        result = await service.buildTransactWitness(msg.inputs as BuildTransactWitnessInputs);
        break;
      case "buildRagequitWitness":
        result = await service.buildRagequitWitness(msg.inputs as BuildRagequitWitnessInputs);
        break;
      default:
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (self as any).postMessage({ id: (msg as any).id, ok: false, error: `Unknown type: ${(msg as any).type}` });
        return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (self as any).postMessage({ id: msg.id, ok: true, result });
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (self as any).postMessage({
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
