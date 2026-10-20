// Ratchet (Mike, 2026-10-13): every pool session spawned its own witness
// worker with its own WebAssembly Poseidon, none were ever terminated, and a
// long session ran the tab out of WebAssembly memory. One worker per page.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { IWitnessPreparationService } from '@privacy-pools-v2/sdk';

import { resetSharedWitnessWorker, WorkerWitnessPreparationService } from '../worker-witness-preparation';

class FakeWorker {
  static created = 0;
  static terminated = 0;
  private listeners: Record<string, Array<(e: unknown) => void>> = {};
  constructor() { FakeWorker.created += 1; }
  addEventListener(type: string, fn: (e: unknown) => void) { (this.listeners[type] ??= []).push(fn); }
  postMessage(msg: { id: number; type: string }) {
    queueMicrotask(() => this.listeners.message?.forEach((fn) => fn({ data: { id: msg.id, ok: true, result: msg.type } })));
  }
  terminate() { FakeWorker.terminated += 1; }
}

const fallback = {} as IWitnessPreparationService;
const g = globalThis as Record<string, unknown>;
let saved: { Worker: unknown; window: unknown };

beforeEach(() => {
  saved = { Worker: g.Worker, window: g.window };
  g.Worker = FakeWorker;
  g.window = {};
  FakeWorker.created = 0;
  FakeWorker.terminated = 0;
  resetSharedWitnessWorker();
});

afterEach(() => {
  resetSharedWitnessWorker();
  g.Worker = saved.Worker;
  g.window = saved.window;
});

describe('witness worker is a page singleton', () => {
  test('many sessions share one worker', async () => {
    const services = Array.from({ length: 5 }, () => new WorkerWitnessPreparationService(fallback));
    const results = await Promise.all(services.map((s) => s.buildDepositWitness({} as never)));
    expect(results).toEqual(Array(5).fill('buildDepositWitness'));
    expect(FakeWorker.created).toBe(1);
  });

  // Review of #262: with a page-wide queue, a worker that never answers (and
  // fires no `error`) would block every later witness build until a reload.
  test('a hung request times out, falls back, and the next request gets a fresh worker', async () => {
    const realPost = FakeWorker.prototype.postMessage;
    FakeWorker.prototype.postMessage = () => {}; // never answers
    const fallbackCalls: string[] = [];
    const svc = new WorkerWitnessPreparationService(
      { buildDepositWitness: async () => { fallbackCalls.push('deposit'); return 'fallback' as never; } } as unknown as IWitnessPreparationService,
      { timeoutMs: 20 },
    );
    expect(await svc.buildDepositWitness({} as never)).toBe('fallback' as never);
    expect(fallbackCalls).toEqual(['deposit']);
    expect(FakeWorker.terminated).toBe(1);

    FakeWorker.prototype.postMessage = realPost;
    const next = new WorkerWitnessPreparationService(fallback);
    expect(await next.buildDepositWitness({} as never)).toBe('buildDepositWitness' as never);
    expect(FakeWorker.created).toBe(2);
  });

  test('one session going away does not kill the worker for the others', async () => {
    const a = new WorkerWitnessPreparationService(fallback);
    const b = new WorkerWitnessPreparationService(fallback);
    await a.buildTransactWitness({} as never);
    a.dispose();
    await b.buildTransactWitness({} as never);
    expect(FakeWorker.created).toBe(1);
    expect(FakeWorker.terminated).toBe(0);
  });
});
