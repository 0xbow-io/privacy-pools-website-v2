import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Execute the component's own closures with controlled network/DOM dependencies.
// This exercises late callbacks without loading React Native or making requests.
function source(path: string) {
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}
const newsletter = source('components/newsletter-modal.tsx');
function find(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node {
  if (predicate(root)) return root;
  const search = (node: ts.Node): ts.Node | undefined =>
    predicate(node) ? node : ts.forEachChild(node, search);
  const result = ts.forEachChild(root, search);
  if (!result) throw new Error('Component expression not found');
  return result;
}
function variable(root: ts.SourceFile, name: string) {
  return (
    find(
      root,
      (node) => ts.isVariableDeclaration(node) && node.name.getText(root) === name,
    ) as ts.VariableDeclaration
  ).initializer!;
}
function evaluate(node: ts.Node, root: ts.SourceFile, context: Record<string, unknown>): unknown {
  const js = ts.transpileModule(`const expression = ${node.getText(root)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(context), `${js}\nreturn expression;`)(
    ...Object.values(context),
  );
}
function submissionFixture(fetch: typeof globalThis.fetch) {
  const state = { step: 'form', email: 'person@example.com', error: null as unknown };
  const submission = { current: null as AbortController | null };
  const context = {
    submission,
    fetch,
    AbortController,
    email: state.email,
    turnstileToken: 'test-token',
    EMAIL_REGEX: /.+@.+\..+/,
    NEWSLETTER_API_URL: '/test-newsletter',
    setStep: (step: string) => {
      state.step = step;
    },
    setEmail: (email: string) => {
      state.email = email;
    },
    setError: (error: unknown) => {
      state.error = error;
    },
    setTurnstileToken: () => {},
    onClose: () => {},
    useCallback: (callback: unknown) => callback,
  };
  return {
    state,
    submission,
    submit: evaluate(
      variable(newsletter, 'handleSubmit'),
      newsletter,
      context,
    ) as () => Promise<void>,
    close: evaluate(variable(newsletter, 'handleClose'), newsletter, context) as () => void,
  };
}

describe('newsletter submission ownership', () => {
  for (const ok of [true, false]) {
    test(`closing ignores a late ${ok ? 'success' : 'failure'} and preserves a newer request`, async () => {
      const pending: ((response: Response) => void)[] = [];
      const fixture = submissionFixture(
        (() => new Promise<Response>((resolve) => pending.push(resolve))) as typeof fetch,
      );
      const first = fixture.submit();
      const oldController = fixture.submission.current!;
      fixture.close();
      expect(oldController.signal.aborted).toBe(true);
      const second = fixture.submit();
      const newController = fixture.submission.current;
      pending[0](
        new Response(JSON.stringify({ error: 'old failure' }), { status: ok ? 200 : 500 }),
      );
      await first;
      expect(fixture.state.step).toBe('loading');
      expect(fixture.state.error).toBeNull();
      expect(fixture.submission.current).toBe(newController);
      pending[1](new Response('{}'));
      await second;
      expect(fixture.state.step).toBe('success');
    });
  }
  test('double submit starts one request and a current failure returns to the form', async () => {
    let calls = 0;
    let reject!: (error: Error) => void;
    const fixture = submissionFixture((() => {
      calls++;
      return new Promise<Response>((_, fail) => {
        reject = fail;
      });
    }) as typeof fetch);
    const pending = fixture.submit();
    await fixture.submit();
    expect(calls).toBe(1);
    reject(new Error('Try again'));
    await pending;
    expect(fixture.state.step).toBe('form');
    expect(fixture.state.error).toBe('Try again');
  });
});

test('Turnstile can retry a script that fails after the modal closes', () => {
  class Element extends EventTarget {
    removed = false;
    remove() {
      this.removed = true;
    }
  }
  let script: Element | undefined;
  const document = {
    querySelector: () => (script?.removed ? null : (script ?? null)),
    createElement: () => new Element(),
    head: {
      appendChild: (element: Element) => {
        script = element;
      },
    },
  };
  const effect = find(
    newsletter,
    (node) =>
      ts.isCallExpression(node) &&
      node.expression.getText(newsletter) === 'useEffect' &&
      node.getText(newsletter).includes('mountWidget'),
  ) as ts.CallExpression;
  const context = {
    Platform: { OS: 'web' },
    visible: true,
    TURNSTILE_SITE_KEY: 'test-key',
    step: 'form',
    captchaNode: new Element(),
    HTMLElement: Element,
    document,
    window: {},
    isDark: false,
    turnstileWidgetId: { current: null },
    setTurnstileToken: () => {},
    setError: () => {},
  };
  const mount = evaluate(effect.arguments[0], newsletter, context) as () => () => void;
  const cleanup = mount();
  const first = script!;
  cleanup();
  first.dispatchEvent(new Event('error'));
  expect(first.removed).toBe(true);
  const cleanupRetry = mount();
  expect(script).not.toBe(first);
  expect(script?.removed).toBe(false);
  cleanupRetry();
});
