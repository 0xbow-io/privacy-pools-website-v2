import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Execute the real sign-out reset effect with provider boundaries stubbed.
const source = ts.createSourceFile('action-hub.tsx', readFileSync(new URL('../../components/home/action-hub.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let effect: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect'
    && node.arguments[0]?.getText(source).includes('wasSignedInRef.current')) effect = node.arguments[0];
  ts.forEachChild(node, visit);
}
visit(source);
const code = ts.transpileModule(`return (${effect!.getText(source)});`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

type Props = { signedIn?: boolean; tabsDisabled?: boolean; isFocused?: boolean; action?: string };

function hub(was = true) {
  const calls: string[] = [];
  const wasSignedInRef = { current: was };
  const signOutResetPendingRef = { current: false };
  const render = ({ signedIn = false, tabsDisabled = false, isFocused = true, action = 'send' }: Props = {}) => {
    calls.length = 0;
    const env = {
      wasSignedInRef, signOutResetPendingRef, signedIn, tabsDisabled, isFocused, action,
      router: { setParams: (p: { action: string }) => calls.push(`action:${p.action}`) },
      setAmounts: () => calls.push('amounts'),
      setUsdInput: () => calls.push('usd'),
      setShieldRecipientOpen: () => calls.push('recipientOpen'),
      setShieldRecipient: () => calls.push('recipient'),
      setSwapRecipientOpen: () => calls.push('swapRecipientOpen'),
      setSwapRecipient: () => calls.push('swapRecipient'),
      depositFlow: { inlineActive: true },
      resetInlineDeposit: () => calls.push('deposit'),
      withdrawIsOpen: false, closeWithdrawModal: () => calls.push('withdraw'),
      transferIsOpen: true, closeTransferModal: () => calls.push('send'),
      requestIsOpen: false, closePaymentRequestModal: () => calls.push('request'),
      swapIsOpen: false, closeSwapModal: () => calls.push('swap'),
    };
    new Function(...Object.keys(env), code)(...Object.values(env))();
    return [...calls];
  };
  return { render, wasSignedInRef, signOutResetPendingRef };
}

const FULL_RESET = ['amounts', 'usd', 'recipientOpen', 'recipient', 'swapRecipientOpen', 'swapRecipient', 'deposit', 'send', 'action:shield'];

test('signing out closes the settled flows, clears the card and returns to shield', () => {
  const h = hub();
  expect(h.render()).toEqual(FULL_RESET);
  expect(h.wasSignedInRef.current).toBe(false);
  expect(h.signOutResetPendingRef.current).toBe(false);
});

test('already on shield leaves the route alone', () => {
  expect(hub().render({ action: 'shield' })).toEqual(FULL_RESET.slice(0, -1));
});

test('a flow still in flight is left to finish, then reset once it settles', () => {
  const h = hub();
  expect(h.render({ tabsDisabled: true })).toEqual([]);
  expect(h.signOutResetPendingRef.current).toBe(true);
  expect(h.render()).toEqual(FULL_RESET);
  expect(h.render()).toEqual([]);
});

test('a retained hub waits for focus before resetting', () => {
  const h = hub();
  expect(h.render({ isFocused: false })).toEqual([]);
  expect(h.render({ isFocused: true })).toEqual(FULL_RESET);
});

test('signing back in drops a pending reset', () => {
  const h = hub();
  h.render({ tabsDisabled: true });
  expect(h.render({ signedIn: true, tabsDisabled: true })).toEqual([]);
  expect(h.signOutResetPendingRef.current).toBe(false);
  expect(h.render({ signedIn: true })).toEqual([]);
});

test('nothing resets without a sign-out edge', () => {
  expect(hub(false).render()).toEqual([]);
  const stay = hub(true);
  expect(stay.render({ signedIn: true })).toEqual([]);
  expect(stay.wasSignedInRef.current).toBe(true);
});
