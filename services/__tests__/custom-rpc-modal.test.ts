import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as rpc from '../../config/custom-rpc';
import { torNeedsGateway, validateTorGatewayFor, type TorSettings } from '../../config/tor';
import { TOR_PROBE_STEP_TEXT } from '../tor-fetch';

const GATEWAY = `127.0.0.1:12298:u${Buffer.from([0x12, 0x20, ...new Array(32).fill(0)]).toString('base64url')}`;
const OTHER_GATEWAY = GATEWAY.replace('12298', '12299');
const source = ts.createSourceFile('custom-rpc-modal-provider.tsx', readFileSync(new URL('../../components/custom-rpc-modal-provider.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = source.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'CustomRpcModalProvider')!;
const body = component.body!.statements.filter(s => !ts.isReturnStatement(s)).map(s => s.getText(source)).join('\n');
const fields = ['openCustomRpcModal', 'closeCustomRpcModal', 'handleSave', 'testAll', 'testTorGateway', 'editRow', 'setTorEnabled', 'setTorProvider', 'setTorGateway', 'setTorAcceptedSuggested', 'setPersist', 'rows', 'skippedIds', 'formError', 'torError', 'torEnabled', 'torGateway', 'torAcceptedSuggested', 'persist', 'checking', 'torChecked', 'torProbing', 'torStatus'];
const code = ts.transpileModule(`${body}; return { ${fields.join(',')} };`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const chains = [{ chainId: 1, name: 'Ethereum' }, { chainId: 10, name: 'Optimism' }];

// Exercise the actual hooks and callbacks with dependency-aware memoization.
// Only native rendering and network/storage boundaries are supplied by the harness.
function modal(options: { active?: TorSettings; suggested?: string; overrides?: rpc.CustomRpcOverrides; device?: boolean; deferTorProbe?: boolean } = {}) {
  let reloads = 0;
  const savedTor: TorSettings[] = [];
  const values: unknown[] = [];
  const memos: { deps: unknown[]; value: unknown }[] = [];
  let cursor = 0;
  let effects: (() => void)[] = [];
  const cleanups: (void | (() => void))[] = [];
  let view: any;
  let stored = options.overrides ?? {};
  const writes: string[] = [];
  const probes: { url: string; chainId: number; options: { fetchImpl?: typeof fetch; timeoutMs?: number } }[] = [];
  let finish: ((value: rpc.RpcProbeResult) => void)[] = [];
  let draftCloses = 0;
  const torSend = Object.assign(async () => Response.json({ result: '0x1' }), { close() { draftCloses++; } });
  let torTests = 0;
  const torProbes: { signal: AbortSignal; step: (step: keyof typeof TOR_PROBE_STEP_TEXT) => void; finish: (result: { ok: true } | { ok: false; message: string }) => void }[] = [];
  let refuseTor = false;
  const env = {
    useTheme: () => ({ colorScheme: 'light' }), Colors: { light: {} }, useWindowDimensions: () => ({ width: 1000 }),
    TOR_ON_DEVICE: options.device ?? false, reloadAppAsync: async () => { reloads++; },
    DEVICE_STORAGE_REFUSED: 'device storage refused',
    ACTIVE_CUSTOM_RPC_PERSISTENCE: 'local', ACTIVE_TOR_SETTINGS: options.active ?? { enabled: false, gatewayUrl: '', provider: 'tor-js' },
    SUGGESTED_TOR_GATEWAY: options.suggested ?? GATEWAY,
    editableChains: () => chains, activeCustomRpcUrl: (id: number) => options.overrides?.[id],
    validateTorGatewayFor, torNeedsGateway, validateCustomRpcUrl: rpc.validateCustomRpcUrl, skippedChainIds: rpc.skippedChainIds,
    detectRpcProvider: rpc.detectRpcProvider, deriveSiblingRpcUrls: rpc.deriveSiblingRpcUrls, RPC_PROBE_MESSAGES: rpc.RPC_PROBE_MESSAGES,
    STORAGE_REFUSED: 'storage refused', TOR_PROBE_TIMEOUT_MS: 60_000, TOR_PROBE_STEP_TEXT,
    createTorFetch: () => torSend, torFetchIfActive: () => options.active?.enabled ? torSend : null,
    probeTorGateway: async (_gateway: string, _timeout: number, _provider: string, step: (step: keyof typeof TOR_PROBE_STEP_TEXT) => void, signal: AbortSignal) => {
      torTests++;
      if (!options.deferTorProbe) return { ok: true };
      return new Promise(resolve => torProbes.push({ signal, step, finish: resolve }));
    },
    probeRpcUrl: (url: string, chainId: number, opts: { fetchImpl?: typeof fetch; timeoutMs?: number }) => {
      probes.push({ url, chainId, options: opts });
      return new Promise<rpc.RpcProbeResult>(resolve => { finish.push(resolve); });
    },
    previewCustomRpcMany: (entries: Record<number, string | null>) => Object.entries(entries)
      .reduce((all, [key, value]) => rpc.withCustomRpc(all, Number(key), value), stored),
    saveTorSettings: (settings: TorSettings) => { writes.push('tor'); savedTor.push(settings); return !refuseTor; },
    applyCustomRpcMany: (entries: Record<number, string | null>) => {
      writes.push('rpc'); stored = env.previewCustomRpcMany(entries); return true;
    },
    useState: (initial: unknown) => {
      const slot = cursor++;
      if (!(slot in values)) values[slot] = initial;
      return [values[slot], (next: unknown) => { values[slot] = typeof next === 'function' ? next(values[slot]) : next; }];
    },
    useRef: (initial: unknown) => {
      const slot = cursor++;
      if (!(slot in values)) values[slot] = { current: initial };
      return values[slot];
    },
    useMemo: (factory: () => unknown, deps: unknown[]) => {
      const slot = cursor++;
      if (!memos[slot] || deps.length !== memos[slot].deps.length || deps.some((d, i) => !Object.is(d, memos[slot].deps[i]))) {
        memos[slot] = { deps, value: factory() };
      }
      return memos[slot].value;
    },
    useCallback: (callback: unknown, deps: unknown[]) => env.useMemo(() => callback, deps),
    useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
      const slot = cursor;
      return env.useMemo(() => { effects.push(() => {
        cleanups[slot]?.();
        cleanups[slot] = effect();
      }); }, deps);
    },
  };
  const evaluate = new Function(...Object.keys(env), code);
  const render = () => {
    cursor = 0;
    effects = [];
    view = evaluate(...Object.values(env));
    effects.forEach(effect => effect());
    return view;
  };
  render().openCustomRpcModal();
  render();
  return { render, writes, probes, torSend, torProbes, draftCloses: () => draftCloses, torTests: () => torTests, stored: () => stored, reloads: () => reloads, savedTor,
    unmount: () => cleanups.forEach(cleanup => cleanup?.()),
    replaceStored: (next: rpc.CustomRpcOverrides) => { stored = next; }, refuseTor: () => { refuseTor = true; },
    finish: (result: rpc.RpcProbeResult = { outcome: 'ok' }) => { const pending = finish; finish = []; pending.forEach(done => done(result)); } };
}

test('on a device, Save writes anon-rpc with no gateway, tick or probe, and restarts the app', async () => {
  const app = modal({ device: true });
  let form = app.render();
  form.setTorEnabled(true);
  form = app.render();
  await form.handleSave();
  expect(app.savedTor).toEqual([{ enabled: true, gatewayUrl: '', provider: 'tor-js' }]);
  // Only the anon-rpc choice: no custom endpoint write, no probe of any kind.
  expect(app.writes).toEqual(['tor']);
  expect(app.probes).toHaveLength(0);
  expect(app.torTests()).toBe(0);
  expect(app.reloads()).toBe(1);
});

test('on a device, saving the setting already in force does not restart the app', async () => {
  const app = modal({ device: true, active: { enabled: true, gatewayUrl: '', provider: 'tor-js' } });
  const form = app.render();
  expect(form.torEnabled).toBe(true);
  await form.handleSave();
  expect(app.writes).toEqual(['tor']);
  expect(app.reloads()).toBe(0);
});

test('on a device, a refused write reports device storage and does not restart', async () => {
  const app = modal({ device: true });
  let form = app.render();
  app.refuseTor();
  form.setTorEnabled(true);
  form = app.render();
  await form.handleSave();
  expect(app.render().formError).toBe('device storage refused');
  expect(app.reloads()).toBe(0);
});

test('a suggested gateway needs explicit consent for both saving and probing', async () => {
  const app = modal();
  let form = app.render();
  expect(form.torGateway).toBe(GATEWAY);
  expect(form.torAcceptedSuggested).toBe(false);
  form.setTorEnabled(true);
  form = app.render();
  await form.handleSave();
  await form.testTorGateway();
  expect(app.writes).toEqual([]);
  expect(app.torTests()).toBe(0);
  expect(app.render().torError).toContain('Tick the box');
  form.setTorAcceptedSuggested(true);
  form = app.render();
  await form.handleSave();
  expect(app.writes).toEqual(['tor', 'rpc']);
});

test('editing away from the suggested address drops consent; reopening resets the entire draft', async () => {
  const app = modal();
  let form = app.render();
  form.setTorEnabled(true);
  form.setTorGateway(OTHER_GATEWAY);
  form = app.render();
  await form.handleSave();
  expect(app.writes).toEqual(['tor', 'rpc']);
  form.setPersist(false);
  form.setTorAcceptedSuggested(true);
  form.closeCustomRpcModal();
  app.render().openCustomRpcModal();
  form = app.render();
  expect(form.torEnabled).toBe(false);
  expect(form.torGateway).toBe(GATEWAY);
  expect(form.torAcceptedSuggested).toBe(false);
  expect(form.persist).toBe(true);
  const saved = modal({ active: { enabled: true, gatewayUrl: GATEWAY, provider: 'tor-js' } }).render();
  expect(saved.torEnabled).toBe(true);
  expect(saved.torAcceptedSuggested).toBe(true);
});

for (const edit of ['consent', 'endpoint', 'new-endpoint', 'persistence', 'tor-enabled', 'gateway', 'provider', 'disable-reenable']) {
  test(`save refuses ${edit} changes while an endpoint probe awaits`, async () => {
    const app = modal();
    let form = app.render();
    form.setTorEnabled(true);
    form.setTorAcceptedSuggested(true);
    form.editRow(1, 'https://one.example');
    form = app.render();
    const pending = form.handleSave();
    expect(app.probes).toHaveLength(1);
    expect(app.probes[0].options.fetchImpl).toBe(app.torSend);
    expect(app.probes[0].options.timeoutMs).toBe(60_000);
    form = app.render();
    if (edit === 'consent') form.setTorAcceptedSuggested(false);
    if (edit === 'endpoint') form.editRow(1, 'https://different.example');
    if (edit === 'new-endpoint') form.editRow(10, 'https://two.example');
    if (edit === 'persistence') form.setPersist(false);
    if (edit === 'tor-enabled') form.setTorEnabled(false);
    if (edit === 'gateway') form.setTorGateway(OTHER_GATEWAY);
    if (edit === 'provider') form.setTorProvider('nox');
    if (edit === 'disable-reenable') {
      form.setTorEnabled(false);
      app.render().setTorEnabled(true);
    }
    app.render();
    app.finish();
    await pending;
    expect(app.writes).toEqual([]);
    expect(app.render().formError).toContain('field changed');
  });
}

test('Tor storage refusal surfaces before endpoint storage and reload', async () => {
  const app = modal();
  app.refuseTor();
  await app.render().handleSave();
  expect(app.writes).toEqual(['tor']);
  expect(app.render().formError).toBe('storage refused');
});

test('a closed and reopened form ignores old endpoint probe completions', async () => {
  const app = modal({ overrides: { 1: 'https://one.example' } });
  app.render().testAll();
  expect(app.probes).toHaveLength(1);
  app.render().closeCustomRpcModal();
  app.render().openCustomRpcModal();
  app.render();
  app.finish();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(app.render().rows[1].status).toBe('idle');
});

test('Tor remains in force for probes while a disabling draft is unsaved', () => {
  const app = modal({ active: { enabled: true, gatewayUrl: GATEWAY, provider: 'tor-js' }, overrides: { 1: 'https://one.example' } });
  app.render().setTorEnabled(false);
  app.render().testAll();
  expect(app.probes[0].options.fetchImpl).toBe(app.torSend);
  app.finish();
});

test('draft warning and saved scan partition include cross-tab and undisplayed overrides', async () => {
  const app = modal({ overrides: { 999: 'https://hidden.example' } });
  let form = app.render();
  expect(form.skippedIds).toEqual([1, 10]);
  form.editRow(1, 'https://one.example');
  form = app.render();
  expect(form.skippedIds).toEqual([10]);
  const pending = form.handleSave();
  app.replaceStored({ 10: 'https://other-tab.example', 999: 'https://hidden.example' });
  app.finish();
  await pending;
  expect(app.writes).toEqual([]);
  form = app.render();
  expect(form.skippedIds).toEqual([]);
  const retry = form.handleSave();
  app.finish();
  await retry;
  expect(app.writes).toEqual(['tor', 'rpc']);
  expect(rpc.skippedChainIds(chains.map(c => c.chainId), app.stored())).toEqual(form.skippedIds);
});

test('Use our RPCs saves the Tor draft first and clears overrides outside the visible environment', async () => {
  const app = modal({ overrides: { 1: 'https://one.example', 999: 'https://hidden.example' } });
  let form = app.render();
  form.setTorEnabled(true);
  form = app.render();
  await form.handleSave(true);
  expect(app.writes).toEqual([]); // resetting endpoints cannot bypass gateway consent
  form.setTorAcceptedSuggested(true);
  form = app.render();
  await form.handleSave(true);
  expect(app.probes).toEqual([]);
  expect(app.writes).toEqual(['tor', 'rpc']);
  expect(app.stored()).toEqual({});
  expect(rpc.queryableChainIds(chains.map(c => c.chainId), app.stored())).toEqual([1, 10]);
});

test('Nym saves and tests with no gateway and no consent tick, even with ours in the box', async () => {
  const app = modal();
  let form = app.render();
  form.setTorEnabled(true);
  form.setTorProvider('nym');
  form = app.render();
  expect(form.torGateway).toBe(GATEWAY);
  await form.testTorGateway();
  expect(app.torTests()).toBe(1);
  form = app.render();
  await form.handleSave();
  expect(app.savedTor).toEqual([{ enabled: true, gatewayUrl: '', provider: 'nym' }]);
});

test('opening, selecting a provider and editing the draft never send requests', () => {
  const app = modal();
  app.render().openCustomRpcModal({ torOnly: true });
  app.render().setTorProvider('nym');
  app.render().setTorProvider('nox');
  app.render().editRow(1, 'https://one.example');
  app.render().closeCustomRpcModal();
  app.render();
  expect(app.probes).toEqual([]);
  expect(app.torTests()).toBe(0);
});

for (const edit of ['close', 'disable', 'provider', 'unmount']) {
  test(`a ${edit} cancels a connection Test and ignores its late result`, async () => {
    const app = modal({ deferTorProbe: true });
    app.render().setTorEnabled(true);
    app.render().setTorProvider('nym');
    const pending = app.render().testTorGateway();
    expect(app.torProbes).toHaveLength(1);
    const form = app.render();
    if (edit === 'close') form.closeCustomRpcModal();
    if (edit === 'disable') form.setTorEnabled(false);
    if (edit === 'provider') form.setTorProvider('nox');
    if (edit === 'unmount') app.unmount();
    else app.render();
    expect(app.torProbes[0].signal.aborted).toBe(true);
    app.torProbes[0].step('checking');
    app.torProbes[0].finish({ ok: true });
    await pending;
    if (edit !== 'unmount') {
      expect(app.render().torChecked).toBe(false);
      expect(app.render().torProbing).toBe(false);
      expect(app.render().torStatus).toBeNull();
    }
  });
}

test('a canceled Test cannot clear a newer provider Test or publish its progress', async () => {
  const app = modal({ deferTorProbe: true });
  app.render().setTorEnabled(true);
  app.render().setTorProvider('nym');
  const first = app.render().testTorGateway();
  app.render().closeCustomRpcModal();
  app.render().openCustomRpcModal({ torOnly: true });
  app.render().setTorProvider('nox');
  const second = app.render().testTorGateway();
  app.torProbes[0].step('checking');
  app.torProbes[0].finish({ ok: false, message: 'old error' });
  await first;
  expect(app.render().torProbing).toBe(true);
  expect(app.render().torError).toBeNull();
  app.torProbes[1].finish({ ok: true });
  await second;
  expect(app.render().torChecked).toBe(true);
});

test('changing the provider invalidates endpoint results still in flight', async () => {
  const app = modal({ active: { enabled: true, gatewayUrl: '', provider: 'nym' }, overrides: { 1: 'https://one.example' } });
  app.render().testAll();
  app.render().setTorProvider('nox');
  app.render();
  app.finish();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(app.render().rows[1].status).toBe('idle');
  expect(app.render().rows[1].warning).toBeNull();
});

test('Save anyway consent for one provider cannot skip checking another', async () => {
  const app = modal({ active: { enabled: true, gatewayUrl: '', provider: 'nym' } });
  app.render().editRow(1, 'https://one.example');
  const first = app.render().handleSave();
  app.finish({ outcome: 'unreachable' });
  await first;
  app.render().setTorProvider('nox');
  app.render();
  const second = app.render().handleSave();
  expect(app.probes).toHaveLength(2);
  expect(app.writes).toEqual([]);
  app.finish();
  await second;
  expect(app.savedTor[0].provider).toBe('nox');
});

test('revoking suggested gateway consent closes a pending endpoint probe transport', async () => {
  const app = modal();
  app.render().setTorEnabled(true);
  app.render().setTorAcceptedSuggested(true);
  app.render().editRow(1, 'https://one.example');
  const pending = app.render().handleSave();
  expect(app.probes).toHaveLength(1);
  expect(app.draftCloses()).toBe(0);
  app.render().setTorAcceptedSuggested(false);
  app.render();
  expect(app.draftCloses()).toBe(1);
  app.finish({ outcome: 'unreachable' });
  await pending;
  expect(app.writes).toEqual([]);
  expect(app.render().formError).toContain('field changed');
});
