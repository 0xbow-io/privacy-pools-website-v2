// Keep Metro's module registrations byte-for-byte in ordered deferred scripts
// so parsing one large bundle does not monopolize the main thread on mobile.
// Synchronous routes put them in index.js, followed by startup calls.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

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
    const chunks = splitModuleRegistrations(await readFile(file, 'utf8'));
    if (chunks.length === 1) continue;
    const tags = [];
    for (const chunk of chunks) {
      const hash = createHash('sha256').update(chunk).digest('hex').slice(0, 24);
      const name = `bootstrap-part-${hash}.js`;
      await writeFile(resolve(dirname(file), name), chunk);
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
