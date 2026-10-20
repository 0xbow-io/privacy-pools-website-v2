// Web Worker entrypoint that runs snarkjs.fullProve / verify off the
// main thread so deposit / withdraw / transfer proof generation doesn't
// freeze the UI.
//
// Protocol: messages are tagged with `id` (for matching responses) and
// `type` ('fullProve' | 'verify'). Replies are `{ id, ok: true, result }`
// or `{ id, ok: false, error }`. Wasm and zkey blobs cross the boundary
// as transferable ArrayBuffers — the caller is responsible for cloning
// them if it needs to reuse the underlying buffers afterward.

import { groth16 } from "snarkjs";

type FullProveMsg = {
  id: number;
  type: "fullProve";
  input: unknown;
  wasm: Uint8Array;
  provingKey: Uint8Array;
};

type VerifyMsg = {
  id: number;
  type: "verify";
  verificationKey: unknown;
  publicSignals: unknown;
  proof: unknown;
};

type WorkerRequest = FullProveMsg | VerifyMsg;

self.addEventListener("message", async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  try {
    if (msg.type === "fullProve") {
      const result = await groth16.fullProve(msg.input as never, msg.wasm, msg.provingKey);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (self as any).postMessage({ id: msg.id, ok: true, result });
    } else if (msg.type === "verify") {
      const result = await groth16.verify(
        msg.verificationKey as never,
        msg.publicSignals as never,
        msg.proof as never,
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (self as any).postMessage({ id: msg.id, ok: true, result });
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (self as any).postMessage({ id: (msg as any).id, ok: false, error: "Unknown message type" });
    }
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (self as any).postMessage({
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
