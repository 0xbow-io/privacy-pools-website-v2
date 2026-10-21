// Keep Metro's module registrations byte-for-byte in ordered deferred scripts
// so parsing one large bundle does not monopolize the main thread on mobile.
// Synchronous routes put them in index.js, followed by startup calls.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decode, encode } from '@jridgewell/sourcemap-codec';
import ts from 'typescript';

const SOURCE_MAP_COMMENT = /\n?\/\/# sourceMappingURL=[^\n]*\s*$/;

/**
 * The source map of each part, cut out of the bundle's own map.
 *
 * The parts are contiguous slices of the bundle, so a part's mappings are the
 * bundle's mappings from its first line on, shifted up, with the first line's
 * columns shifted left. Without this a production frame in a part names a
 * file Sentry has no map for, and the stack is unreadable.
 */
export function splitSourceMap(source, map, chunks) {
  const lines = decode(map.mappings);
  const maps = [];
  let offset = 0;
  for (const chunk of chunks) {
    const before = source.slice(0, offset);
    const startLine = before.split('\n').length - 1;
    const startCol = offset - (before.lastIndexOf('\n') + 1);
    const lineCount = chunk.split('\n').length;
    const lastLen = chunk.length - (chunk.lastIndexOf('\n') + 1);
    const part = [];
    for (let i = 0; i < lineCount; i++) {
      let segments = lines[startLine + i] ?? [];
      if (i === lineCount - 1) {
        const end = i === 0 ? startCol + lastLen : lastLen;
        segments = segments.filter((seg) => seg[0] < end);
      }
      if (i === 0) {
        segments = segments.filter((seg) => seg[0] >= startCol).map((seg) => [seg[0] - startCol, ...seg.slice(1)]);
      }
      part.push(segments);
    }
    const { debugId: _debugId, debug_id: _debug_id, file: _file, ...rest } = map;
    maps.push({ ...rest, mappings: encode(part) });
    offset += chunk.length;
  }
  return maps;
}

export function splitModuleRegistrations(source, maxBytes = 256 * 1024) {
  if (Buffer.byteLength(source) <= maxBytes) return [source];
  const program = ts.createSourceFile('bootstrap.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (program.parseDiagnostics.length) throw new Error('Cannot parse Metro bootstrap bundle');
  const chunks = [];
  let pending = '';
  let end = 0;
  let startup = false;
  let registrations = false;
  for (const statement of program.statements) {
    const call = ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
      ? statement.expression : null;
    const name = call && ts.isIdentifier(call.expression) ? call.expression.text : null;
    // Metro sometimes embeds its runtime in index.js. Keep that prelude whole
    // and execute it before any module registration, regardless of its size.
    if (!registrations && !startup && name !== '__d' && name !== '__r') {
      pending += source.slice(end, statement.end);
      end = statement.end;
      continue;
    }
    if (name === '__d' && !registrations && !startup) {
      if (pending) chunks.push(pending);
      pending = '';
      registrations = true;
    }
    const startsModule = name === '__r' && call.arguments.length === 1
      && (ts.isNumericLiteral(call.arguments[0]) || ts.isStringLiteral(call.arguments[0]));
    if (!(name === '__d' && !startup) && !startsModule) {
      // An unfamiliar graph is still executable as emitted by Metro.
      console.warn('Leaving Metro bootstrap unsplit: unfamiliar statement order');
      return [source];
    }
    // Start execution in its own script, after every factory is registered.
    if (startsModule && !startup) {
      if (pending) chunks.push(pending);
      pending = '';
      startup = true;
    }
    const code = source.slice(end, statement.end);
    end = statement.end;
    if (pending && Buffer.byteLength(pending + code) > maxBytes) {
      chunks.push(pending);
      pending = '';
    }
    pending += code;
  }
  chunks.push(pending + source.slice(end));
  return chunks;
}

export async function splitWebBootstrap(dist) {
  const index = resolve(dist, 'index.html');
  let html = await readFile(index, 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*src="([^"]+)"[^>]*>\s*<\/script>/g)];
  for (const [tag, url] of scripts) {
    if (!/^\/_expo\/static\/js\/web\/(?:__common|index)[^/]*\.js$/.test(url)) continue;
    if (!/\bdefer(?:\s|=|>)/.test(tag) || /\b(?:async|integrity|type)=?/.test(tag)) {
      throw new Error('Expected a deferred classic script for the Metro bootstrap bundle');
    }
    const file = resolve(dist, `.${url}`);
    const source = (await readFile(file, 'utf8')).replace(SOURCE_MAP_COMMENT, '');
    const chunks = splitModuleRegistrations(source);
    if (chunks.length === 1) continue;
    // Present only when the export ran with --source-maps (scripts/sentry-sourcemaps.mjs).
    const mapFile = `${file}.map`;
    const maps = existsSync(mapFile)
      ? splitSourceMap(source, JSON.parse(await readFile(mapFile, 'utf8')), chunks)
      : null;
    const tags = [];
    for (const [i, chunk] of chunks.entries()) {
      const hash = createHash('sha256').update(chunk).digest('hex').slice(0, 24);
      const name = `bootstrap-part-${hash}.js`;
      if (maps) {
        await writeFile(resolve(dirname(file), `${name}.map`), JSON.stringify({ ...maps[i], file: name }));
        await writeFile(resolve(dirname(file), name), `${chunk}\n//# sourceMappingURL=${name}.map\n`);
      } else {
        await writeFile(resolve(dirname(file), name), chunk);
      }
      tags.push(tag.replace(url, `${url.slice(0, url.lastIndexOf('/') + 1)}${name}`));
    }
    html = html.replace(tag, tags.join('\n'));
    console.log(`Split ${url} into ${chunks.length} ordered scripts`);
  }
  await writeFile(index, html);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await splitWebBootstrap(resolve(process.argv[2] ?? 'dist'));
}
