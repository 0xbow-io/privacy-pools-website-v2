import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitModuleRegistrations, splitWebBootstrap } from '../split-web-bootstrap.mjs';

function execute(scripts: string[]) {
  const modules = new Map<number, { factory: Function; dependencies: number[] }>();
  const registered: number[] = [];
  const context = { __d: (factory: Function, id: number, dependencies: number[]) => {
    registered.push(id); modules.set(id, { factory, dependencies });
  } };
  for (const script of scripts) runInNewContext(script, context);
  const load = (id: number): { answer: string } => {
    const { factory, dependencies } = modules.get(id)!;
    const exports = {};
    factory(load, exports, dependencies);
    return exports as { answer: string };
  };
  return { answer: load(1).answer, registered };
}

test('separate scripts retain factory dependencies, registration order and Unicode strings', () => {
  const source = `/* license */\n__d(function(require,exports,deps) { exports.answer = require(deps[0]).answer + ' ✓'; }, 1, [2]);
/* another module */\n__d(function(require,exports) { exports.answer = 'private'; }, 2, []);\n/* end */`;
  const chunks = splitModuleRegistrations(source, 100);
  expect(chunks.length).toBeGreaterThan(1);
  expect(execute(chunks)).toEqual({ answer: 'private ✓', registered: [1, 2] });
  expect(execute(chunks)).toEqual(execute([source]));
});

test('a factory larger than the limit stays intact', () => {
  const source = `__d(function(require,exports) { exports.answer = '${'x'.repeat(500)}'; }, 1, []);`;
  expect(execute(splitModuleRegistrations(source, 100)).answer).toBe('x'.repeat(500));
});

test('keeps an inline Metro runtime whole and executes it before registrations and startup', () => {
  const prelude = 'var __BUNDLE_START_TIME__=0,process=globalThis.process||{};process.env={NODE_ENV:"production"};'
    + 'var modules={};globalThis.__d=(factory,id)=>{modules[id]=factory;};globalThis.__r=id=>modules[id]();';
  const source = prelude + '__d(function(){globalThis.answer+=process.env.NODE_ENV;},1,[]);'
    + '__d(function(){globalThis.answer="ready:";},2,[]);__r(2);__r(1);';
  const chunks = splitModuleRegistrations(source, 40);
  expect(chunks[0]).toBe(prelude);
  expect(chunks.join('')).toBe(source);
  const context: { answer?: string } = {};
  for (const chunk of chunks) runInNewContext(chunk, context);
  expect(context.answer).toBe('ready:production');
  expect(chunks.at(-1)).toBe('__r(2);__r(1);');
});

test('leaves unfamiliar statement order intact instead of breaking the build', () => {
  for (const source of ['__r(1); __d(function() {}, 1, []);', '__r(getEntry());', 'startApp();']) {
    expect(splitModuleRegistrations(source, 1)).toEqual([source]);
  }
});

test('splits the synchronous entry in HTML and remains idempotent', async () => {
  const dist = await mkdtemp(join(tmpdir(), 'web-bootstrap-'));
  try {
    const url = '/_expo/static/js/web/index-test.js';
    await mkdir(join(dist, '_expo/static/js/web'), { recursive: true });
    const source = `__d(function(){ return '${'x'.repeat(180_000)}'; },1,[]);\n`
      + `__d(function(){ return '${'y'.repeat(180_000)}'; },2,[]);\n__r(1);`;
    await writeFile(join(dist, url), source);
    await writeFile(join(dist, 'index.html'), `<script src="${url}" defer></script>`);
    await splitWebBootstrap(dist);
    const html = await readFile(join(dist, 'index.html'), 'utf8');
    const scripts = [...html.matchAll(/src="([^"]+)" defer/g)].map(match => match[1]);
    expect(scripts.length).toBe(3);
    const chunks = await Promise.all(scripts.map(file => readFile(join(dist, file), 'utf8')));
    expect(chunks.join('')).toBe(source);
    expect(chunks.at(-1)).toBe('\n__r(1);');
    await splitWebBootstrap(dist);
    expect(await readFile(join(dist, 'index.html'), 'utf8')).toBe(html);
  } finally {
    await rm(dist, { recursive: true, force: true });
  }
});

test('each part gets the slice of the bundle source map that covers it', async () => {
  const { splitSourceMap } = await import('../split-web-bootstrap.mjs');
  const { decode } = await import('@jridgewell/sourcemap-codec');
  const source = 'aa\nbbXcc\ndd';
  // One segment at every character: [genCol, src 0, line, col]
  const lines = source.split('\n').map((line, l) => [...line].map((_, c) => [c, 0, l, c]));
  const { encode } = await import('@jridgewell/sourcemap-codec');
  const map = { version: 3, sources: ['a.ts'], names: [], mappings: encode(lines as never), debugId: 'x' };
  const parts = splitSourceMap(source, map, ['aa\nbb', 'Xcc\ndd']);
  expect(decode(parts[0].mappings)).toEqual([[[0, 0, 0, 0], [1, 0, 0, 1]], [[0, 0, 1, 0], [1, 0, 1, 1]]]);
  expect(decode(parts[1].mappings)).toEqual([[[0, 0, 1, 2], [1, 0, 1, 3], [2, 0, 1, 4]], [[0, 0, 2, 0], [1, 0, 2, 1]]]);
  expect(parts[0].debugId).toBeUndefined();
});
