/**
 * Browser runtime for the Stellar SDK: everything the StellarPoolSessionBuilder
 * needs that the SDK does not ship ready for a browser against a long-lived
 * testnet deployment.
 *
 * - Event history and ASP data from the environment's ASP (asp-v2, ASP_URL). Soroban RPC only
 *   serves a retention window (about a week on testnet), so every event read goes to asp-v2's
 *   GET /:chainId/public/events, which archives the deployment's whole history.
 * - Circuit artifacts fetched from the site's own /artifacts (the EVM circuits,
 *   which the Stellar verifier uses unchanged).
 * - A relayer interactor that reports "no relayers": prepareWithdraw and
 *   prepareTransfer always ask, and the builder's default stub throws.
 *
 * Privacy: asp-v2 is read in bulk only (events by contract id and start ledger, the pool's
 * leaves and label lists), exactly what the SDK would otherwise ask the public RPC for.
 * Nothing sent to it is derived from this user's notes.
 */
import type {
  EventSnapshot,
  Hash,
  Hex,
  IASPDataProvider,
  ICircuitArtifacts,
  IRelayerInteractor,
  LabelStatus,
  NoteEvent,
  PublicKey,
  StellarAddress,
  StellarGetEventsParams,
  StellarGetEventsResult,
} from '@privacy-pools-v2/stellar-sdk';

import {
  STELLAR_ARTIFACT_BASE_URL,
  STELLAR_TESTNET_CONTRACTS,
  STELLAR_TESTNET_ID,
  STELLAR_TESTNET_NETWORK,
  STELLAR_TESTNET_RPC_URL,
} from '@/config/stellar-deployment';

export type StellarSdk = typeof import('@privacy-pools-v2/stellar-sdk');

const ASP_TIMEOUT_MS = 20_000;
const ARTIFACT_TIMEOUT_MS = 120_000;

let sdkPromise: Promise<StellarSdk> | null = null;

/** Lazy-loads the Stellar SDK (it pulls in snarkjs and circomlibjs). */
export function loadStellarSdk(): Promise<StellarSdk> {
  sdkPromise ??= import('@privacy-pools-v2/stellar-sdk');
  return sdkPromise;
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ events

export type StellarRpcInteractor = InstanceType<StellarSdk['SorobanRPCInteractor']>;

/** The indexed interactor, plus the sync pass that answers whole-history reads from one page. */
export type IndexedStellarRpcInteractor = StellarRpcInteractor & {
  /** Runs `fn` with whole-history pool event reads answered from one page (see below). */
  withEventPage<T>(fn: () => Promise<T>): Promise<T>;
};

// A fromLedger past every indexed ledger: asp-v2 answers with no events, only its coverage.
const PAST_INDEXED_LEDGER = 999_999_999n;

/**
 * The SDK's Soroban RPC interactor with every event read served by asp-v2 (same StellarLog
 * objects the RPC path builds), injected through StellarPoolSessionBuilder's `rpcInteractor`.
 *
 * Single source: no event read falls back to RPC. RPC getEvents silently clamps an older start up
 * to the node's retention floor, so a scan would drop earlier events while discovery still advanced
 * its cursor; failing keeps the cursor where it was. The head (getLatestLedger) is asp-v2's indexed
 * ledger too, so discovery never moves past events asp-v2 has not served yet: a just-landed event
 * shows up on the next sync. Everything else (simulate, send, ledger entries) stays on RPC.
 *
 * Whole-history reads inside a sync pass come from one page. Note discovery asks the pool adapter
 * when each newly found commitment was inserted, and on Stellar each answer is a whole-history
 * event scan (retried on a miss). Nothing in those requests names the note, but their number would
 * follow how many notes this client just found. Inside `withEventPage` the first whole-history read
 * of the pool fetches the page and every later one (the activity index's too) is answered from it,
 * so a sync makes the same requests whatever it finds. A page older than a ledger some other read
 * in the pass already reported is fetched again, so it always covers what discovery has seen.
 * Outside a pass (a flow waiting on its own transaction) every read is live.
 */
export function createIndexedRpcInteractor(sdk: StellarSdk, aspUrl: string): IndexedStellarRpcInteractor {
  const fetchEvents = async (contractId: string, fromLedger: bigint): Promise<StellarGetEventsResult> => {
    const url =
      `${aspUrl}/${STELLAR_TESTNET_ID}/public/events` +
      `?contractId=${encodeURIComponent(contractId)}&fromLedger=${fromLedger.toString()}`;
    try {
      return await fetchJson<StellarGetEventsResult>(url, ASP_TIMEOUT_MS);
    } catch (error) {
      throw new sdk.ASPUnavailable(`Stellar ASP event history unavailable: ${String(error)}`);
    }
  };

  // Open passes; while one is open, the whole-history pool page and the newest ledger any
  // read in the pass reported.
  let passes = 0;
  const pages = new Map<string, Promise<StellarGetEventsResult>>();
  let newestSeen = 0n;
  let passHead: Promise<Hex> | null = null;
  const note = (latestLedger: Hex) => {
    try {
      const ledger = BigInt(latestLedger);
      if (passes > 0 && ledger > newestSeen) newestSeen = ledger;
    } catch {
      // Not a number: nothing to compare against.
    }
  };

  const wholeHistory = async (contractId: string): Promise<StellarGetEventsResult> => {
    const cached = pages.get(contractId);
    if (cached) {
      const page = await cached.catch(() => null);
      if (page && BigInt(page.latestLedger) >= newestSeen) return page;
      if (pages.get(contractId) !== cached) return wholeHistory(contractId);
    }
    const pending = fetchEvents(contractId, 0n);
    pages.set(contractId, pending);
    // A failed fetch is not kept: the next read in the pass tries again.
    pending.catch(() => { if (pages.get(contractId) === pending) pages.delete(contractId); });
    const page = await pending;
    // Another read may have reported a newer ledger while this one was in flight.
    if (BigInt(page.latestLedger) < newestSeen) {
      if (pages.get(contractId) === pending) pages.delete(contractId);
      return wholeHistory(contractId);
    }
    return page;
  };

  class IndexedSorobanRPCInteractor extends sdk.SorobanRPCInteractor {
    override async getEvents(params: StellarGetEventsParams): Promise<StellarGetEventsResult> {
      const { cursor } = params;
      // Event ids and cursors are '<TOID>-<index>' (ledger = TOID >> 32) and fixed-width, so string order is chain order.
      const from = cursor ? BigInt(cursor.split('-')[0]) >> 32n : params.startLedger ? BigInt(params.startLedger) : 0n;
      // The pool only: its reads are the ones made per note.
      const result = passes > 0 && !cursor && from === 0n && params.contractId === STELLAR_TESTNET_CONTRACTS.poolContractId
        ? await wholeHistory(params.contractId)
        : await fetchEvents(params.contractId, from);
      note(result.latestLedger);
      const events = cursor ? result.events.filter((event) => event.id > cursor) : result.events;
      return { events, latestLedger: result.latestLedger, cursor: events.at(-1)?.id ?? cursor };
    }

    override async getLatestLedger(): Promise<Hex> {
      // One head per pass too: the token resolver asks for it once per note it cannot place yet.
      if (passes > 0 && passHead) return passHead;
      const pending = fetchEvents(STELLAR_TESTNET_CONTRACTS.poolContractId, PAST_INDEXED_LEDGER).then((r) => r.latestLedger);
      if (passes > 0) {
        passHead = pending;
        pending.catch(() => { if (passHead === pending) passHead = null; });
      }
      const head = await pending;
      note(head);
      return head;
    }

    async withEventPage<T>(fn: () => Promise<T>): Promise<T> {
      passes++;
      try {
        return await fn();
      } finally {
        if (--passes === 0) {
          pages.clear();
          passHead = null;
          newestSeen = 0n;
        }
      }
    }
  }
  return new IndexedSorobanRPCInteractor({ rpcUrl: STELLAR_TESTNET_RPC_URL, networkPassphrase: STELLAR_TESTNET_NETWORK.networkPassphrase });
}

// ------------------------------------------------------------------ ASP

/**
 * IASPDataProvider over asp-v2, scoped to the Stellar pool like the SDK's HttpASPDataProvider.
 * Snapshot and note-event endpoints are deliberately absent: the SDK then reads chain events
 * (served by asp-v2 through the patched getEvents).
 */
export class StellarTestnetAspProvider implements IASPDataProvider {
  constructor(private readonly sdk: StellarSdk, private readonly baseUrl: string) {}

  private async get<T>(path: string): Promise<T> {
    try {
      return await fetchJson<T>(`${this.baseUrl}${path}`, ASP_TIMEOUT_MS);
    } catch (error) {
      throw new this.sdk.ASPUnavailable(`Stellar ASP unreachable at ${this.baseUrl}: ${String(error)}`);
    }
  }

  private get poolQuery(): string {
    return `chainId=${STELLAR_TESTNET_ID}&entrypoint=${encodeURIComponent(STELLAR_TESTNET_CONTRACTS.poolContractId)}`;
  }

  async getRoot(): Promise<Hash> {
    const { root } = await this.get<{ root: string }>(`/association-set/root?${this.poolQuery}`);
    // asp-v2 answers "0" for a pool with no published tree.
    if (!root || BigInt(root) === 0n) throw new this.sdk.ASPUnavailable('The Stellar ASP has not approved any deposit yet');
    return this.sdk.bigintToHex(BigInt(root));
  }

  async getLeaves(): Promise<Hash[]> {
    const { leaves } = await this.get<{ leaves: string[] }>(`/association-set/leaves?${this.poolQuery}`);
    return leaves.map((leaf) => this.sdk.bigintToHex(BigInt(leaf)));
  }

  // Classified locally from the pool's bulk sets, so no request names this user's label (same order as asp-v2's
  // per-label status: the latest decision first, then tree membership).
  async getLabelStatus(labelHash: Hash): Promise<LabelStatus> {
    const [rejected, poiRequired, leaves] = await Promise.all([
      this.get<{ labels: string[] }>(`/labels/rejected?${this.poolQuery}`),
      this.get<{ labels: string[] }>(`/labels/poi-required?${this.poolQuery}`),
      this.get<{ leaves: string[] }>(`/association-set/leaves?${this.poolQuery}`),
    ]);
    const wanted = BigInt(labelHash);
    const has = (set: string[]) => set.some((value) => BigInt(value) === wanted);
    if (has(rejected.labels)) return { status: 'rejected' };
    if (has(poiRequired.labels)) return { status: 'poi_required' };
    return { status: has(leaves.leaves) ? 'approved' : 'pending' };
  }

  async getASPPublicKey(): Promise<PublicKey> {
    return (await this.get<{ publicKey: PublicKey }>('/public-key')).publicKey;
  }

  async getEventSnapshot(): Promise<EventSnapshot> {
    throw new this.sdk.ASPUnavailable('The Stellar ASP serves no event snapshot');
  }

  async getNoteEvents(): Promise<{ events: NoteEvent[]; lastSyncedBlock: Hex }> {
    throw new this.sdk.ASPUnavailable('The Stellar ASP serves no note events');
  }
}

// ------------------------------------------------------------------ artifacts

/** Same layout as public/artifacts (and v2-monorepo packages/circuits/build). */
export class FetchCircuitArtifacts implements ICircuitArtifacts {
  private readonly cache = new Map<string, Promise<Uint8Array>>();

  constructor(private readonly baseUrl: string = STELLAR_ARTIFACT_BASE_URL) {}

  private load(path: string): Promise<Uint8Array> {
    let pending = this.cache.get(path);
    if (!pending) {
      pending = (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ARTIFACT_TIMEOUT_MS);
        try {
          const res = await fetch(`${this.baseUrl}/${path}`, { signal: controller.signal });
          if (!res.ok) throw new Error(`circuit artifact ${path}: ${res.status}`);
          return new Uint8Array(await res.arrayBuffer());
        } finally {
          clearTimeout(timer);
        }
      })();
      // A failed download must not poison the cache for the next attempt.
      pending.catch(() => this.cache.delete(path));
      this.cache.set(path, pending);
    }
    return pending;
  }

  getWasm(name: string): Promise<Uint8Array> {
    return this.load(`${name}/${name}_js/${name}.wasm`);
  }

  getProvingKey(name: string): Promise<Uint8Array> {
    return this.load(`${name}/groth16_pkey.zkey`);
  }

  getVerificationKey(name: string): Promise<Uint8Array> {
    return this.load(`${name}/groth16_vkey.json`);
  }
}

// ------------------------------------------------------------------ relayer

/**
 * "No relayers configured": getRelayers() resolves [] so self-submitted
 * withdrawals and transfers settle their (empty) quote round cleanly; every
 * other method throws. Same shape as the SDK e2e's noRelayerInteractor.
 */
export function createNoRelayerInteractor(sdk: StellarSdk): IRelayerInteractor<StellarAddress> {
  return new Proxy({} as IRelayerInteractor<StellarAddress>, {
    get(_target, prop) {
      if (prop === 'getRelayers') return async () => [];
      if (prop === 'then') return undefined;
      return (): never => {
        throw new sdk.InvalidBuilderConfig(`No Stellar relayer is configured (${String(prop)})`);
      };
    },
  });
}
