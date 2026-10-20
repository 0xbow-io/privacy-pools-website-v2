import { describe, expect, test } from 'bun:test';

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

import { ALLOWED_CODE_KEYS, ALLOWED_DIAGNOSTIC_KEYS, ALLOWED_FLAGS, TELEMETRY_MESSAGES } from '../telemetry-event';

/**
 * The CALLERS, not the boundary.
 *
 * services/__tests__/telemetry-event.test.ts proves the constructor drops a
 * non-boolean, an unknown flag name and a free-form message. That is the last
 * line, and it is SILENT: a caller that passes a string where a boolean was
 * expected loses the field with no error anywhere, so the report arrives
 * looking clean and says nothing. And a caller that passes a note-derived value
 * which happens to be a boolean is waved straight through.
 *
 * WHY THIS IS AN AST PASS AND NOT A REGEX. The first version of this file
 * matched source text, and codex walked through it in four different ways:
 * `import { sendTelemetryEvent as emit }` was invisible to a scan that looked
 * for the spelling; `(reportTelemetry as any)('withdraw-failed', {...})` was
 * not a recognised callee; a line containing the characters `//` truncated the
 * scanned text and hid the call after it; and `hasAmount: enteredAmountWei > 0n`
 * satisfied a "looks boolean" rule while exporting form state. Matching text is
 * not the same as knowing what the code does.
 *
 * A TEST rather than a lint rule because this app's CI runs `bun test` and
 * nothing else — same reasoning as services/__tests__/no-targeted-reads.test.ts.
 */

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');

/**
 * Directories that ship nothing to a user. EVERYTHING ELSE IS SCANNED,
 * including a top-level directory that does not exist yet: the earlier version
 * listed five roots by hand and silently skipped api/ and constants/.
 */
const NOT_SHIPPED = new Set([
  'node_modules', '.git', '.expo', 'dist', 'build', 'coverage',
  'tests', 'scripts', 'workflows', 'docs', 'plans', 'patches',
  'assets', 'public', 'vendor', 'types', 'metro-shims', '.claude', '.vercel',
]);

/** The one module allowed to speak to the platform client. */
const TELEMETRY_ENTRY = 'services/telemetry.ts';
const SENTRY_SINKS = ['services/telemetry-sentry.ts', 'services/telemetry-sentry.web.ts'];

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('.') && entry !== '.claude') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (NOT_SHIPPED.has(entry)) continue;
        walk(full);
      } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry) && !full.includes('__tests__')) {
        out.push(full);
      }
    }
  };
  for (const entry of readdirSync(ROOT)) {
    const full = join(ROOT, entry);
    if (!statSync(full).isDirectory()) {
      if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) out.push(full);
      continue;
    }
    if (NOT_SHIPPED.has(entry) || entry.startsWith('.')) continue;
    walk(full);
  }
  return out;
}

type CallSite = { file: string; line: number; args: ts.NodeArray<ts.Expression>; node: ts.CallExpression; text: string };

/** Every call of the telemetry reporter, found through its IMPORT BINDING. */
function scan() {
  const calls: CallSite[] = [];
  const sinkImporters: string[] = [];
  const suspicious: string[] = [];

  for (const file of sources()) {
    const rel = relative(ROOT, file);
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true,
      /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

    // Which local names, in THIS file, are bound to the reporter and the sink —
    // an alias is still the same function.
    const reporterNames = new Set<string>();
    let importsSink = false;
    source.forEachChild((node) => {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
      const from = node.moduleSpecifier.text;
      const bindings = node.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) return;
      for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (imported === 'reportTelemetry') reporterNames.add(element.name.text);
        if (imported === 'sendTelemetryEvent') importsSink = true;
      }
    });
    if (importsSink) sinkImporters.push(rel);

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (ts.isIdentifier(callee) && reporterNames.has(callee.text)) {
          calls.push({
            file: rel,
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            args: node.arguments,
            node,
            text: node.getText(source),
          });
        } else if (!ts.isIdentifier(callee)) {
          // A cast, a parenthesis or an optional call that still reaches the
          // binding is a shape this validator does not understand, so it is
          // refused rather than skipped.
          for (const name of reporterNames) {
            if (callee.getText(source).includes(name)) {
              suspicious.push(`${rel}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${callee.getText(source)}`);
            }
          }
        }
      }
      node.forEachChild(visit);
    };
    source.forEachChild(visit);
  }
  return { calls, sinkImporters, suspicious };
}

const SCAN = scan();

/**
 * THE REVIEWED SET. Not a shape rule — the actual decision, written down.
 *
 * The state flags stay rejected, and for the reason they were rejected the
 * first time: hasQuote/hasCommitment/hasAmount because the reportXError
 * callbacks are pinned to their render while the setters run in the same
 * synchronous block as the failure, so they would describe a different
 * attempt; hasPoolAccount because it means two different things in two
 * providers; isSwap because it is constant false in the prod bundle;
 * hasRecipient because the deposit form of it exports a distinction the chain
 * deliberately hides.
 *
 * WHAT CHANGED (2026-09-16). Those flags were also, separately, useless: each
 * is true for practically every failure of a flow that has an amount and a
 * quote, so none of them separates one cause from another. Six deposit
 * failures arrived in one morning and the reporter could not say why for any
 * of them. So the call sites now spread `classifyFailure(...)`, which returns
 * at most one FAILURE-CLASS boolean and cannot return anything else, and pass
 * a third argument carrying values that only a staging build ever sends.
 *
 * The spread is written verbatim here, so a call site cannot quietly start
 * spreading something that is not the classifier.
 */
const CLASSIFIER_SPREAD = '...classifyFailure(msg, cause)';

/**
 * `spreads` is what the call site's flag object is allowed to spread, and it
 * defaults to the classifier because a flow failure is classified. The error
 * boundary sets it to nothing at all: it catches a RENDER crash, which has no
 * relayer, no quote and no chain response to classify, so every one of those
 * booleans would be a guess. What it sends instead is `code`, the fourth
 * argument, which is reviewed by key here because unlike the diagnostic bag it
 * travels in a real-money session.
 */
const REVIEWED: Record<string, {
  message: string;
  flags: Record<string, string>;
  spreads?: string[];
  /** The keys of a fourth `code` argument, which prod sends. */
  code?: string[];
}> = {
  'components/withdraw-modal-provider.tsx': { message: 'withdraw-failed', flags: { testMode: 'TEST_MODE === true' } },
  'components/deposit-modal-provider.tsx': { message: 'deposit-failed', flags: { testMode: 'TEST_MODE === true' } },
  'components/transfer-modal-provider.tsx': { message: 'transfer-failed', flags: { testMode: 'TEST_MODE === true' } },
  'components/app-error-boundary.tsx': {
    message: 'client-failed',
    flags: {},
    spreads: [],
    code: ['errorName', 'componentFrame'],
  },
};

describe('what the call sites are allowed to say', () => {
  test('the scan reaches the app at all', () => {
    const files = sources().map((f) => relative(ROOT, f));
    // If this ever fails the scan has stopped seeing the code and every
    // assertion below is vacuous.
    for (const dir of ['components/', 'services/', 'hooks/', 'app/', 'config/', 'api/', 'constants/']) {
      expect(files.some((f) => f.startsWith(dir))).toBe(true);
    }
    expect(files.length).toBeGreaterThan(200);
  });

  test('every reporter call is one of the reviewed ones, verbatim', () => {
    const seen = new Map<string, number>();
    for (const call of SCAN.calls) {
      const reviewed = REVIEWED[call.file];
      expect({ at: `${call.file}:${call.line}`, reviewed: reviewed !== undefined })
        .toEqual({ at: `${call.file}:${call.line}`, reviewed: true });
      seen.set(call.file, (seen.get(call.file) ?? 0) + 1);

      // A fourth argument is the `code` bag, which travels in EVERY
      // environment, so a site that passes one has to be reviewed for it by
      // name rather than allowed to appear.
      expect({ at: `${call.file}:${call.line}`, argc: call.args.length })
        .toEqual({ at: `${call.file}:${call.line}`, argc: reviewed.code ? 4 : 3 });

      // The message: a bare literal on the union, never a template or variable
      // that could carry the error text.
      const [message, flags, diagnostic] = call.args;
      expect({ at: `${call.file}:${call.line}`, literalMessage: ts.isStringLiteral(message) })
        .toEqual({ at: `${call.file}:${call.line}`, literalMessage: true });
      const key = (message as ts.StringLiteral).text;
      expect(Object.hasOwn(TELEMETRY_MESSAGES, key)).toBe(true);
      expect(key).toBe(reviewed.message);

      // The flags: an inline object literal, so the decision is readable right
      // where this scan reads it.
      expect({ at: `${call.file}:${call.line}`, inlineFlags: ts.isObjectLiteralExpression(flags) })
        .toEqual({ at: `${call.file}:${call.line}`, inlineFlags: true });
      const properties = (flags as ts.ObjectLiteralExpression).properties;
      const got: Record<string, string> = {};
      const spreads: string[] = [];
      for (const property of properties) {
        // One spread is allowed, and only the classifier's, written out in
        // full. Anything else must be a plain `name: expression`.
        if (ts.isSpreadAssignment(property)) {
          spreads.push(property.getText().replace(/\s+/g, ' '));
          continue;
        }
        expect({ at: `${call.file}:${call.line}`, plainAssignment: ts.isPropertyAssignment(property) })
          .toEqual({ at: `${call.file}:${call.line}`, plainAssignment: true });
        const assignment = property as ts.PropertyAssignment;
        expect({ at: `${call.file}:${call.line}`, plainName: ts.isIdentifier(assignment.name) })
          .toEqual({ at: `${call.file}:${call.line}`, plainName: true });
        got[(assignment.name as ts.Identifier).text] = assignment.initializer.getText().replace(/\s+/g, ' ');
      }
      // Exactly the reviewed flags, with exactly the reviewed expressions.
      expect(got).toEqual(reviewed.flags);
      for (const name of Object.keys(got)) expect(ALLOWED_FLAGS as readonly string[]).toContain(name);
      expect({ at: `${call.file}:${call.line}`, spreads })
        .toEqual({ at: `${call.file}:${call.line}`, spreads: reviewed.spreads ?? [CLASSIFIER_SPREAD] });

      // The diagnostic bag: an inline object literal whose every key is on
      // ALLOWED_DIAGNOSTIC_KEYS. The constructor enforces the same list, so
      // this is about keeping the call sites readable rather than about
      // safety — but a key that is not on the list is a value someone meant
      // to send and did not, which is worth failing over here.
      expect({ at: `${call.file}:${call.line}`, inlineDiagnostic: ts.isObjectLiteralExpression(diagnostic) })
        .toEqual({ at: `${call.file}:${call.line}`, inlineDiagnostic: true });
      for (const property of (diagnostic as ts.ObjectLiteralExpression).properties) {
        // `...(cond ? { address } : {})` is how an optional field is written,
        // and it is the ONLY spread shape accepted here. The first version
        // scraped keys out of the source text with a regex, which accepted
        // `...diagnosticBag` (zero keys found, nothing checked, test green)
        // and saw only the first property of `...(c ? { address, note } : {})`
        // (codex, 2026-09-16). Walking the AST is the difference between
        // reviewing the values and appearing to.
        if (ts.isSpreadAssignment(property)) {
          // `...(cond ? a : b)` parses the parentheses as their own node.
          const conditional = ts.isParenthesizedExpression(property.expression)
            ? property.expression.expression
            : property.expression;
          expect({ at: `${call.file}:${call.line}`, shape: ts.isConditionalExpression(conditional) })
            .toEqual({ at: `${call.file}:${call.line}`, shape: true });
          const branches = [
            (conditional as ts.ConditionalExpression).whenTrue,
            (conditional as ts.ConditionalExpression).whenFalse,
          ];
          let validated = 0;
          for (const branch of branches) {
            expect({ at: `${call.file}:${call.line}`, branchIsObject: ts.isObjectLiteralExpression(branch) })
              .toEqual({ at: `${call.file}:${call.line}`, branchIsObject: true });
            for (const member of (branch as ts.ObjectLiteralExpression).properties) {
              // Every property of every branch, not just the first.
              const recognised = ts.isPropertyAssignment(member) || ts.isShorthandPropertyAssignment(member);
              expect({ at: `${call.file}:${call.line}`, recognised }).toEqual({ at: `${call.file}:${call.line}`, recognised: true });
              const key = ((member as ts.PropertyAssignment | ts.ShorthandPropertyAssignment).name as ts.Identifier).text;
              expect({ at: `${call.file}:${call.line}`, key, allowed: (ALLOWED_DIAGNOSTIC_KEYS as readonly string[]).includes(key) })
                .toEqual({ at: `${call.file}:${call.line}`, key, allowed: true });
              validated += 1;
            }
          }
          // A spread that validated nothing is a spread that was not reviewed.
          expect({ at: `${call.file}:${call.line}`, validated: validated > 0 })
            .toEqual({ at: `${call.file}:${call.line}`, validated: true });
          continue;
        }
        const name = ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)
          ? (property.name as ts.Identifier).text
          : '<unrecognised>';
        expect({ at: `${call.file}:${call.line}`, name, allowed: (ALLOWED_DIAGNOSTIC_KEYS as readonly string[]).includes(name) })
          .toEqual({ at: `${call.file}:${call.line}`, name, allowed: true });
      }

      // The code bag. Held to a stricter shape than the diagnostic one,
      // because this is what a real-money session sends: an inline literal,
      // no spread of any kind, and exactly the reviewed keys in order.
      if (reviewed.code) {
        const bag = call.args[3]!;
        expect({ at: `${call.file}:${call.line}`, inlineCode: ts.isObjectLiteralExpression(bag) })
          .toEqual({ at: `${call.file}:${call.line}`, inlineCode: true });
        const names: string[] = [];
        for (const property of (bag as ts.ObjectLiteralExpression).properties) {
          const recognised = ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property);
          expect({ at: `${call.file}:${call.line}`, recognisedCode: recognised })
            .toEqual({ at: `${call.file}:${call.line}`, recognisedCode: true });
          names.push(((property as ts.PropertyAssignment).name as ts.Identifier).text);
        }
        expect({ at: `${call.file}:${call.line}`, names }).toEqual({ at: `${call.file}:${call.line}`, names: reviewed.code });
        for (const name of names) expect(ALLOWED_CODE_KEYS as readonly string[]).toContain(name);
      }
    }
    // ...and each reviewed site really does still make its call, so reverting
    // to the one-argument form fails here rather than passing quietly.
    for (const file of Object.keys(REVIEWED)) expect({ file, calls: seen.get(file) }).toEqual({ file, calls: 1 });
  });

  test('the reporter is never reached through a cast, a parenthesis or an optional call', () => {
    expect(SCAN.suspicious).toEqual([]);
  });

  test('only the telemetry entry point imports the platform sink', () => {
    expect(SCAN.sinkImporters.sort()).toEqual([TELEMETRY_ENTRY]);
    // and the sink modules themselves are the only other place it may live
    for (const sink of SENTRY_SINKS) expect(SCAN.sinkImporters).not.toContain(sink);
  });
});

describe('the allowlist is a decision, not a default', () => {
  test('the flag names are exactly the reviewed set', () => {
    expect([...ALLOWED_FLAGS]).toEqual([
      'hasAmount', 'hasRecipient', 'hasPoolAccount', 'hasCommitment', 'hasAspLeaves',
      'hasStateLeaves', 'hasRelayer', 'hasQuote', 'isSwap', 'isBatch', 'testMode',
      'isUserRejected', 'isQuoteExpired', 'isSessionError', 'isRelayerRejected',
      'isValidationError', 'isNetworkError', 'isChainReverted',
    ]);
  });

  test('the diagnostic keys are exactly the reviewed set, and frozen', () => {
    expect([...ALLOWED_DIAGNOSTIC_KEYS]).toEqual(['stage', 'detail', 'address', 'amount', 'asset', 'chainId']);
    expect(Object.isFrozen(ALLOWED_DIAGNOSTIC_KEYS)).toBe(true);
  });

  test('the allowlist cannot be widened at runtime', () => {
    expect(Object.isFrozen(ALLOWED_FLAGS)).toBe(true);
    expect(() => (ALLOWED_FLAGS as unknown as string[]).push('walletBit')).toThrow();
    expect(ALLOWED_FLAGS as readonly string[]).not.toContain('walletBit');
  });
});
