import { describe, it, expect } from 'vitest';
import { SuiChainReader, EventPaginationError } from '@/services/sui-witness/chain-reader';

/**
 * Chain reader (paginated event reads + object-field reads). A fake SuiClient
 * returns canned queryEvents pages / getObject content; we assert the reader
 * walks all pages, fails LOUD on a page cap / ordering gap, and decodes the pool
 * gvk_enabled / gvk fields. No network is touched.
 */

interface Page {
  data: { parsedJson: Record<string, unknown> }[];
  hasNextPage: boolean;
  nextCursor: { txDigest: string; eventSeq: string } | null;
}

/** A fake SuiClient with programmable queryEvents pages keyed by call index. */
function makeClient(opts: {
  pages?: Page[];
  pool?: Record<string, unknown>;
}) {
  let call = 0;
  return {
    async queryEvents() {
      const pages = opts.pages ?? [];
      const page = pages[call] ?? { data: [], hasNextPage: false, nextCursor: null };
      call += 1;
      return page;
    },
    async getObject() {
      return { data: { content: { fields: opts.pool ?? {} } } };
    },
    async getDynamicFieldObject() {
      return { data: { content: { fields: { value: '0' } } } };
    },
  };
}

function reader(client: unknown, overrides: Record<string, unknown> = {}) {
  return new SuiChainReader({
    client: client as never,
    packageId: '0xpkg',
    poolId: '0xpool',
    keystoreId: '0xks',
    aspRegistryId: '0xasp',
    ...overrides,
  });
}

describe('paginated event reads', () => {
  it('walks MULTIPLE pages to exhaustion (hasNextPage drives the cursor)', async () => {
    const pages: Page[] = [
      { data: [{ parsedJson: { x: '1' } }], hasNextPage: true, nextCursor: { txDigest: 'a', eventSeq: '1' } },
      { data: [{ parsedJson: { x: '2' } }], hasNextPage: true, nextCursor: { txDigest: 'b', eventSeq: '2' } },
      { data: [{ parsedJson: { x: '3' } }], hasNextPage: false, nextCursor: null },
    ];
    const r = reader(makeClient({ pages }));
    const events = await r.getNoteEvents();
    expect(events).toHaveLength(3);
    expect(events.map((e) => (e.parsedJson as { x: string }).x)).toEqual(['1', '2', '3']);
  });

  it('terminates on a NON-ADVANCING cursor (buggy RPC echoing the same cursor)', async () => {
    const stuck = { txDigest: 'same', eventSeq: '1' };
    const pages: Page[] = [
      { data: [{ parsedJson: { x: '1' } }], hasNextPage: true, nextCursor: stuck },
      // returns the SAME cursor again -> reader must stop (not spin to the cap).
      { data: [{ parsedJson: { x: '2' } }], hasNextPage: true, nextCursor: stuck },
    ];
    const r = reader(makeClient({ pages }));
    const events = await r.getDepositEvents({ cursor: stuck });
    // First page appended, second page's repeat cursor halts the walk.
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it('THROWS when the page cap is exceeded (never a silent partial)', async () => {
    // Every page says hasNextPage:true with an advancing cursor -> hits the cap.
    let i = 0;
    const client = {
      async queryEvents() {
        i += 1;
        return {
          data: [{ parsedJson: { x: String(i) } }],
          hasNextPage: true,
          nextCursor: { txDigest: `t${i}`, eventSeq: String(i) },
        };
      },
    };
    const r = reader(client, { maxPagesPerFetch: 3 });
    await expect(r.getTransactEvents()).rejects.toThrow(EventPaginationError);
  });
});

describe('state-leaf reconstruction ordering guard', () => {
  it('concatenates LeavesInserted leaves in event order', async () => {
    const pages: Page[] = [
      {
        data: [
          { parsedJson: { start_index: '0', leaves: ['10', '11'] } },
          { parsedJson: { start_index: '2', leaves: ['12'] } },
        ],
        hasNextPage: false,
        nextCursor: null,
      },
    ];
    const r = reader(makeClient({ pages }));
    const leaves = await r.reconstructStateLeaves();
    expect(leaves).toEqual([10n, 11n, 12n]);
  });

  it('FAILS LOUD on a start_index gap (a dropped page would mis-order the tree)', async () => {
    const pages: Page[] = [
      {
        data: [
          { parsedJson: { start_index: '0', leaves: ['10', '11'] } },
          // start_index should be 2 but is 5 -> gap.
          { parsedJson: { start_index: '5', leaves: ['12'] } },
        ],
        hasNextPage: false,
        nextCursor: null,
      },
    ];
    const r = reader(makeClient({ pages }));
    await expect(r.reconstructStateLeaves()).rejects.toThrow(/ordering gap/);
  });

  it('FAILS LOUD on a keystore LeafInserted index gap', async () => {
    const pages: Page[] = [
      {
        data: [
          { parsedJson: { index: '0', leaf: '100' } },
          { parsedJson: { index: '2', leaf: '101' } }, // should be 1
        ],
        hasNextPage: false,
        nextCursor: null,
      },
    ];
    const r = reader(makeClient({ pages }));
    await expect(r.reconstructKeystoreLeaves()).rejects.toThrow(/ordering gap/);
  });
});

describe('pool object-field reads (gvk)', () => {
  it('reads gvk_enabled across boolean/number/string encodings', async () => {
    expect(await reader(makeClient({ pool: { gvk_enabled: true } })).getGvkEnabled()).toBe(true);
    expect(await reader(makeClient({ pool: { gvk_enabled: false } })).getGvkEnabled()).toBe(false);
    expect(await reader(makeClient({ pool: { gvk_enabled: 0 } })).getGvkEnabled()).toBe(false);
    expect(await reader(makeClient({ pool: { gvk_enabled: '1' } })).getGvkEnabled()).toBe(true);
  });

  it('defaults gvk_enabled to TRUE when the field is absent (older snapshot)', async () => {
    expect(await reader(makeClient({ pool: {} })).getGvkEnabled()).toBe(true);
  });

  it('reads the pool GVK coords as bigints', async () => {
    const gvk = await reader(makeClient({ pool: { gvk_x: '42', gvk_y: '43' } })).getPoolGvk();
    expect(gvk).toEqual({ x: 42n, y: 43n });
  });

  it('THROWS reading GVK from a stale snapshot with no gvk_x/gvk_y', async () => {
    await expect(reader(makeClient({ pool: {} })).getPoolGvk()).rejects.toThrow(/no gvk_x\/gvk_y/);
  });

  it('reads the live root_buffer dropping zero entries', async () => {
    const pool = { root_buffer: { fields: { buffer: ['0', '5', '0', '7'] } } };
    const roots = await reader(makeClient({ pool })).getPoolRootBuffer();
    expect(roots).toEqual([5n, 7n]);
  });
});
