/**
 * A swap-send to yourself reshields; another address receives a wallet payout.
 * Execute the form's actual predicates, callbacks and recipient effects with
 * controlled dependencies. Loading the entire provider would require Expo,
 * wagmi and the pools tree. Parsing the expressions keeps the branch exits and
 * useCallback dependencies under test without duplicating the dispatch here.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { getAddress, isAddress } from 'viem';
import { isSwapSendSelection } from '@/services/intent-swaps';
import { preferredReceiveAsset } from '@/services/receive-asset-pick';

const here = new URL('.', import.meta.url).pathname;
const read = (...parts: string[]) => readFileSync(join(here, '..', '..', ...parts), 'utf8');
const TRANSFER = read('components', 'transfer-modal-provider.tsx');
const HANDOFF = read('services', 'swap-handoff.ts');
const HUB = read('components', 'home', 'action-hub.tsx');
const source = ts.createSourceFile('transfer.tsx', TRANSFER, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function find<T extends ts.Node>(predicate: (node: ts.Node) => node is T): T {
  const matches: T[] = [];
  const visit = (node: ts.Node) => {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(matches).toHaveLength(1);
  return matches[0];
}
function initializer(name: string): ts.Expression {
  return find((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name) && node.name.text === name).initializer!;
}
function effect(hook: string, marker: string): ts.CallExpression {
  return find((node): node is ts.CallExpression => ts.isCallExpression(node)
    && ts.isIdentifier(node.expression) && node.expression.text === hook
    && node.arguments[0].getText(source).includes(marker));
}
const compiled = new Map<ts.Node, string>();
function evaluate<T = any>(node: ts.Node, bindings: Record<string, any>): T {
  let code = compiled.get(node);
  if (!code) {
    code = ts.transpileModule(`const value = (${node.getText(source)});`, {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None },
    }).outputText;
    compiled.set(node, code);
  }
  return new Function(...Object.keys(bindings), `${code}\nreturn value;`)(...Object.values(bindings));
}
const OWN = getAddress(`0x${'a'.repeat(40)}`);
const OTHER = getAddress(`0x${'b'.repeat(40)}`);
const THIRD = getAddress(`0x${'c'.repeat(40)}`);
const INPUT = `0x${'d'.repeat(40)}`;
const OUTPUT = `0x${'e'.repeat(40)}`;
const accountEffect = effect('useLayoutEffect', 'recipientAccountRef');
const ensEffect = effect('useEffect', 'setRecipientEnsError(ENS_UNSUPPORTED_MESSAGE)');
const caption = find((node): node is ts.JsxAttribute => ts.isJsxAttribute(node)
  && node.name.getText(source) === 'caption'
  && node.initializer!.getText(source).includes('isSwapSend')).initializer as ts.JsxExpression;
function copyCondition(text: string): ts.Expression {
  return find((node): node is ts.ConditionalExpression => ts.isConditionalExpression(node)
    && node.whenTrue.getText(source).includes(text)).condition;
}
const publicCopy = copyCondition('Paid to this address on-chain, so the recipient and amount are public.');
const privateCopy = copyCondition('Stays private: the swapped amount comes back as a new note of your own.');
const privateSendCopy = copyCondition('Stays private: the recipient gets a new shielded note.');

function form(overrides: Record<string, any> = {}) {
  const requests: { surface: string; request: Record<string, any> }[] = [];
  const errors: string[] = [];
  const closes: boolean[] = [];
  const callbacks = new Map<string, { fn: Function; deps: unknown[] }>();
  let layoutDeps: unknown[] | undefined;
  let hookName = '';
  const state: Record<string, any> = {
    chainId: 1, sendChainId: 1, receiveAsAvailable: true,
    receiveAsset: { address: OUTPUT, symbol: 'USDC' }, selectedTokenId: INPUT,
    connectedAddress: OWN, recipientInput: OTHER, recipientAddress: OTHER,
    isOpen: true, step: 'select-notes', isSui: false, isStellar: false,
    selectedToken: 'ppETH', selectedSymbol: 'ppETH', amount: '0.1',
    sendChainName: 'Destination', resolvedRecipientName: null,
    recipientEnsResolving: false, recipientEnsError: null,
    tabAccepts: true, modalAccepts: true, inlineBase: false,
    isAddress, isSwapSendSelection, sameAssetAddresses: [INPUT],
    isSameAsset: (address: string) => address.toLowerCase() === INPUT,
    // External dependencies: two wallet destinations, one with a pool route.
    getSwapDestinationChains: () => [1, 10, 56],
    // No output the PRIVATE route can deliver by default, so a third-party send
    // is the public payout. The private route has its own describe below.
    getSwapOutputTokens: () => [],
    // Identity unless a test wraps an asset in a share.
    conversionDepositTarget: (address: string) => address,
    crossChainReshieldSupported: (_source: number, destination: number) => destination === 10,
    // No yield share anywhere by default, so a cross-chain third-party send is public.
    isConfiguredShareTarget: () => false,
    normalizeEnsName: (value: string) => value.includes('.') ? value.trim().toLowerCase() : null,
    displayTokenSymbol: (symbol: string) => symbol,
    useMemo: (fn: () => unknown) => fn(),
    useLayoutEffect: (fn: () => void, deps: unknown[]) => {
      if (!layoutDeps || deps.some((dep, i) => !Object.is(dep, layoutDeps![i]))) fn();
      layoutDeps = deps;
    },
    useCallback: (fn: Function, deps: unknown[]) => {
      const previous = callbacks.get(hookName);
      if (previous && deps.length === previous.deps.length
        && deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return previous.fn;
      callbacks.set(hookName, { fn, deps });
      return fn;
    },
    reportTransferError: (message: string) => errors.push(message),
    setIsOpen: (open: boolean) => closes.push(open),
    requestSwapTab: (request: Record<string, any>) => {
      requests.push({ surface: 'tab', request });
      return state.tabAccepts;
    },
    openWithdrawModal: (_tx: unknown, opts: Record<string, any>) => {
      // The third-party route opens WITHDRAW, which owns public payouts.
      requests.push({ surface: 'withdraw', request: opts });
      return true;
    },
    requestSwap: (request: Record<string, any>) => {
      requests.push({ surface: 'modal', request });
      return state.modalAccepts;
    },
    drafts: [] as Record<string, any>[],
    saveSwapSendDraft: (draft: Record<string, any>) => { state.drafts.push(draft); },
    ...overrides,
  };
  state.recipientInputRef = { current: state.recipientInput };
  state.recipientAccountRef = { current: state.connectedAddress?.toLowerCase() };
  state.currentIdentityRef = { current: state.connectedAddress?.toLowerCase() ?? null };
  for (const name of ['recipientInput', 'recipientAddress', 'resolvedRecipientName', 'recipientEnsResolving', 'recipientEnsError']) {
    state[`set${name[0].toUpperCase()}${name.slice(1)}`] = (value: unknown) => { state[name] = value; };
  }
  const render = () => {
    state.currentIdentityRef.current = state.connectedAddress?.toLowerCase() ?? null;
    // Layout effects clear the previous account's form before it is painted.
    evaluate(accountEffect, state);
    for (const name of ['sendDestinations', 'crossChainSend', 'isSwapSend', 'sendsToOwnAccount', 'privateSwapRoute', 'recipientResolved', 'privateOutputChainId', 'privateOutputAddress', 'privateSwapSend', 'publicSwapPayout', 'recipientEnsName', 'handoffSwapSend', 'handleRecipientInputChange']) {
      hookName = name;
      state[name] = evaluate(initializer(name), state);
    }
  };
  render();
  return { state, requests, errors, closes, render, handoff: () => state.handoffSwapSend() };
}

describe('same asset on the same chain is a plain send (DEV-530)', () => {
  // A yield pool's note is the share; "Recipient receives" can be its plain
  // underlying, which reads the same. Both must be the ordinary private send.
  const SHARE = `0x${'5'.repeat(40)}`;
  const PLAIN = `0x${'6'.repeat(40)}`;
  test('the share or its underlying is not a swap-send; another token is', () => {
    const pair = [SHARE, PLAIN];
    for (const address of [SHARE, PLAIN, PLAIN.toUpperCase().replace('0X', '0x')]) {
      const { state } = form({ selectedTokenId: SHARE, sameAssetAddresses: pair, receiveAsset: { address, symbol: 'USDC' } });
      expect(state.isSwapSend).toBe(false);
      expect(state.publicSwapPayout).toBe(false);
    }
    const { state } = form({ selectedTokenId: SHARE, sameAssetAddresses: pair, receiveAsset: { address: OUTPUT, symbol: 'USDT' } });
    expect(state.isSwapSend).toBe(true);
  });
});

describe('swap-send dispatch', () => {
  for (const destination of [1, 10, 56]) {
    test(`third-party payout to chain ${destination} carries the address and never calls the tab`, () => {
      const f = form({ sendChainId: destination });
      f.handoff();
      // Withdraw's own prefill shape, not the swap modal's: it is a different
      // surface with a different opener.
      expect(f.requests).toEqual([{ surface: 'withdraw', request: {
        tokenSymbol: 'ppETH',
        amount: '0.1',
        receiveTokenAddress: OUTPUT,
        receiveChainId: destination,
        targetAddress: OTHER,
      } }]);
      expect(f.closes).toEqual([false]);
      expect(f.errors).toEqual([]);
    });
    test(`self-send to chain ${destination} reshields or refuses`, () => {
      for (const tabAccepts of [true, false]) {
        const f = form({ sendChainId: destination, recipientAddress: OWN, recipientInput: OWN, tabAccepts });
        f.handoff();
        if (destination === 56) {
          expect(f.requests).toEqual([]);
          expect(f.closes).toEqual([]);
          expect(f.errors).toEqual(['This swap route is not available on this network yet.']);
        } else {
          const request = { tokenSymbol: 'ppETH', initialAmount: '0.1', outputTokenAddress: OUTPUT,
            ...(destination !== 1 ? { destinationChainId: destination } : {}) };
          expect(f.requests).toEqual([
            { surface: 'tab', request },
            ...(!tabAccepts ? [{ surface: 'modal', request: { ...request, mode: 'reshield' } }] : []),
          ]);
          expect(f.closes).toEqual([false]);
          expect(f.errors).toEqual([]);
        }
      }
    });
  }
  test('a private receiver refusal keeps the form open and never switches route', () => {
    // Both private receivers refuse: the hub tab, then the pinned modal. The
    // form stays open and says so rather than falling through to the public
    // route, which is the direction that would publish something.
    const f = form({ recipientAddress: OWN, recipientInput: OWN, tabAccepts: false, modalAccepts: false });
    f.handoff();
    expect(f.closes).toEqual([]);
    expect(f.errors).toHaveLength(1);
    expect(f.requests.map((r) => r.request.mode ?? 'tab')).toEqual(['tab', 'reshield']);
  });
  test('the public route has no refusal to handle, because Withdraw cannot drop it', () => {
    // openWithdrawModal returns void. Its one early exit re-opens itself after
    // the signature, so a request is never silently dropped and closing this
    // form behind it cannot strand the user. If that opener ever grows a real
    // refusal, this test is where it has to be handled.
    const f = form({ recipientAddress: OTHER, recipientInput: OTHER, tabAccepts: false, modalAccepts: false });
    f.handoff();
    expect(f.requests.map((r) => r.surface)).toEqual(['withdraw']);
    expect(f.closes).toEqual([false]);
    expect(f.errors).toEqual([]);
  });
  test('missing, invalid and unresolved recipients refuse without a handoff', () => {
    for (const recipientAddress of ['', 'alice.eth', '0x1234']) {
      const f = form({ recipientAddress });
      f.handoff();
      expect(f.requests).toEqual([]);
      expect(f.closes).toEqual([]);
      expect(f.errors).toEqual(['Enter a valid recipient address.']);
    }
  });
  test('ordinary sends and missing output selections do not hand off', () => {
    for (const overrides of [{ receiveAsset: null }, { receiveAsAvailable: false }, { receiveAsset: { address: INPUT } }]) {
      const f = form(overrides);
      f.handoff();
      expect(f.requests).toEqual([]);
      expect(f.errors).toEqual([]);
    }
  });
  test('a cross-chain selection of the same asset is still a swap', () => {
    const f = form({ sendChainId: 10, receiveAsset: { address: INPUT } });
    f.handoff();
    expect(f.requests[0].request).toMatchObject({ targetAddress: OTHER, receiveChainId: 10, receiveTokenAddress: INPUT });
  });
  test('useCallback captures the latest recipient even when the route booleans stay the same', () => {
    const f = form();
    const previous = f.state.handoffSwapSend;
    f.state.handleRecipientInputChange(THIRD);
    f.render();
    expect(f.state.handoffSwapSend).not.toBe(previous);
    f.handoff();
    expect(f.requests[0].request.targetAddress).toBe(THIRD);
  });
});

describe('recipient edits and account changes', () => {
  test('case and surrounding whitespace choose the same route as the normalized address', () => {
    for (const recipient of [OWN, OTHER]) {
      for (const input of [recipient, recipient.toLowerCase(), `  ${recipient}\n`]) {
        const f = form();
        f.state.handleRecipientInputChange(input);
        f.render();
        f.handoff();
        expect(f.state.recipientAddress).toBe(input.trim());
        expect(f.requests[0].surface).toBe(recipient === OWN ? 'tab' : 'withdraw');
        if (recipient !== OWN) expect(f.requests[0].request.targetAddress).toBe(input.trim());
      }
    }
  });
  test('padded prefills are normalized before validation', () => {
    const value = evaluate<string>(initializer('prefilledRecipient'), { prefill: { recipient: ` ${OTHER}\n` }, forcedFromPrefill: null, swapSendDraft: null });
    expect(value).toBe(OTHER);
    expect(isAddress(value, { strict: false })).toBe(true);
    expect(evaluate<string>(initializer('prefilledRecipient'), { prefill: { recipient: OTHER }, forcedFromPrefill: ['a', 'b'], connectedAddress: OWN, swapSendDraft: null })).toBe(OWN);
    // Back from an unsettled private swap-send, the saved draft's recipient wins.
    expect(evaluate<string>(initializer('prefilledRecipient'), { prefill: { inline: true }, forcedFromPrefill: null, swapSendDraft: { recipient: THIRD } })).toBe(THIRD);
  });
  test('switching or disconnecting accounts clears the form recipient before another handoff', () => {
    for (const recipient of [OWN, OTHER]) {
      for (const nextAccount of [THIRD, undefined]) {
        const f = form({ recipientAddress: recipient, recipientInput: recipient });
        f.state.connectedAddress = nextAccount;
        f.render();
        f.handoff();
        expect(f.state.recipientInput).toBe('');
        expect(f.state.recipientAddress).toBe('');
        expect(f.requests).toEqual([]);
        expect(f.errors).toEqual(['Enter a valid recipient address.']);
      }
    }
  });
  test('an address casing change does not reset the recipient', () => {
    const f = form();
    f.state.connectedAddress = OWN.toLowerCase();
    f.render();
    expect(f.state.recipientAddress).toBe(OTHER);
  });
  test('account changes do not rewrite a settled transfer receipt', () => {
    const f = form({ step: 'success' });
    f.state.connectedAddress = THIRD;
    f.render();
    expect(f.state.recipientAddress).toBe(OTHER);
  });
  test('selecting and undoing a swap preserves the typed recipient', () => {
    const f = form({ receiveAsset: null });
    f.state.receiveAsset = { address: OUTPUT };
    f.render();
    expect(f.state.publicSwapPayout).toBe(true);
    f.state.receiveAsset = null;
    f.render();
    expect(f.state.isSwapSend).toBe(false);
    expect(f.state.recipientInput).toBe(OTHER);
    expect(f.state.recipientAddress).toBe(OTHER);
  });
});

/**
 * Paying someone else in another asset is PRIVATE when the output is one the
 * private route can deliver (reshield-and-transfer: a yield share, same chain),
 * and a public Withdraw otherwise. The output decides, not the recipient alone,
 * because offering the private route for an output it cannot deliver is the form
 * that says yes and then refuses.
 */
describe('private swap-send to someone else', () => {
  const supported = { getSwapOutputTokens: () => [{ address: OUTPUT, symbol: 'ppUSDT' }] };

  test('a supported output hands the recipient to the swap modal, never to Withdraw', () => {
    const f = form({ ...supported });
    f.handoff();
    expect(f.requests).toEqual([{ surface: 'modal', request: {
      tokenSymbol: 'ppETH',
      initialAmount: '0.1',
      outputTokenAddress: OUTPUT,
      recipient: OTHER,
      mode: 'reshield',
    } }]);
    expect(f.closes).toEqual([false]);
    expect(f.errors).toEqual([]);
    expect(f.state.privateSwapSend).toBe(true);
    expect(f.state.publicSwapPayout).toBe(false);
  });

  // Mike's #219 QA: from the hub's Send tab the private swap-send runs in the
  // widget, not a separate modal. Off the hub it stays the modal.
  test('from the inline Send tab the private swap-send asks for the inline flow', () => {
    const f = form({ ...supported, inlineBase: true });
    f.handoff();
    expect(f.requests).toEqual([{ surface: 'modal', request: {
      tokenSymbol: 'ppETH',
      initialAmount: '0.1',
      outputTokenAddress: OUTPUT,
      recipient: OTHER,
      mode: 'reshield',
      inline: true,
    } }]);
    expect(f.closes).toEqual([false]);
    // The form is saved for this owner so Edit can bring it back as it was.
    expect(f.state.drafts).toEqual([{ owner: OWN.toLowerCase(), chainId: 1, recipient: OTHER, sendChainId: 1, receiveAsset: { address: OUTPUT, symbol: 'USDC' } }]);
  });

  // Mike's DEV-509 QA (2026-10-06): the picker offers plain USDT, the pool is
  // ppUSDT. The private test compares the pool the chain wraps the pick in, and
  // the swap flow is asked for that pool, not the plain coin.
  test('a plain pick whose chain wraps it in a share is private and hands off the share', () => {
    const SHARE = '0x6c17be9c864254ca4b2d36223f31ade94b4d64c2';
    const f = form({
      getSwapOutputTokens: () => [{ address: SHARE, symbol: 'ppUSDT' }],
      conversionDepositTarget: (address: string) => address === OUTPUT ? SHARE : address,
    });
    f.handoff();
    expect(f.state.privateSwapSend).toBe(true);
    expect(f.state.publicSwapPayout).toBe(false);
    expect(f.requests).toEqual([{ surface: 'modal', request: {
      tokenSymbol: 'ppETH',
      initialAmount: '0.1',
      outputTokenAddress: SHARE,
      recipient: OTHER,
      mode: 'reshield',
    } }]);
  });

  // Reshield-and-transfer builds the recipient's deposit for a yield share AND
  // for a plain pool asset (v2-monorepo #472), so "private" is exactly "a
  // reshield target on this chain". The form never asks which kind it is: a
  // plain asset (BNB, FDUSD on BNB Chain) is as private as a share.
  test('a listed output is private whether it is a yield share or a plain asset', () => {
    for (const symbol of ['ppUSDT', 'FDUSD']) {
      const f = form({ getSwapOutputTokens: () => [{ address: OUTPUT, symbol }] });
      f.handoff();
      expect(f.requests.map((r) => r.surface)).toEqual(['modal']);
      expect(f.state.privateSwapSend).toBe(true);
    }
  });

  test('an output with no reshield target is the one that stays a public Withdraw', () => {
    // The wider delivery list also offers assets with no pool to land in.
    const f = form({ getSwapOutputTokens: () => [{ address: THIRD }] });
    f.handoff();
    expect(f.requests.map((r) => r.surface)).toEqual(['withdraw']);
    expect(f.state.privateSwapSend).toBe(false);
    expect(f.state.publicSwapPayout).toBe(true);
  });

  test('the output is matched case-insensitively, because addresses arrive both ways', () => {
    const f = form({ getSwapOutputTokens: () => [{ address: OUTPUT.toUpperCase().replace('0X', '0x') }] });
    f.handoff();
    expect(f.requests.map((r) => r.surface)).toEqual(['modal']);
  });

  test('an output the private route cannot deliver stays a public Withdraw', () => {
    const f = form({ getSwapOutputTokens: () => [{ address: INPUT }] });
    f.handoff();
    expect(f.requests.map((r) => r.surface)).toEqual(['withdraw']);
    expect(f.state.privateSwapSend).toBe(false);
    expect(f.state.publicSwapPayout).toBe(true);
  });

  test('another chain is the public route for a plain output, even a listed one', () => {
    const f = form({ ...supported, sendChainId: 10 });
    f.handoff();
    expect(f.requests.map((r) => r.surface)).toEqual(['withdraw']);
    expect(f.state.privateSwapSend).toBe(false);
  });

  // Reshield-and-transfer-crosschain only lands a configured yield SHARE on the
  // destination, so that is exactly when another chain is private.
  test('another chain is private for a yield share there, and hands off the destination', () => {
    const outputsSeen: unknown[][] = [];
    const f = form({
      sendChainId: 10,
      getSwapOutputTokens: (...args: unknown[]) => { outputsSeen.push(args); return [{ address: OUTPUT, symbol: 'ppUSDT' }]; },
      isConfiguredShareTarget: (address: string, chain: number) => address === OUTPUT && chain === 10,
    });
    f.handoff();
    expect(f.state.privateSwapSend).toBe(true);
    expect(f.state.publicSwapPayout).toBe(false);
    // The list asked is the DESTINATION's, as reached from this chain.
    expect(outputsSeen).toContainEqual([10, 1]);
    expect(f.requests).toEqual([{ surface: 'modal', request: {
      tokenSymbol: 'ppETH',
      initialAmount: '0.1',
      outputTokenAddress: OUTPUT,
      destinationChainId: 10,
      recipient: OTHER,
      mode: 'reshield',
    } }]);
  });

  // Mike, #251 QA: the picker shows the coin, so a plain pick the destination
  // wraps in a share takes the private route as that share.
  test('a plain pick across chains is private as the share that chain wraps it in', () => {
    const SHARE = `0x${'5'.repeat(40)}`;
    const seen: unknown[][] = [];
    const f = form({
      sendChainId: 10,
      getSwapOutputTokens: () => [{ address: SHARE }],
      conversionDepositTarget: (...args: unknown[]) => { seen.push(args); return SHARE; },
      isConfiguredShareTarget: (a: string) => a === SHARE,
    });
    f.handoff();
    expect(f.state.privateSwapSend).toBe(true);
    expect(seen[0]?.[1]).toBe(10);
    expect(f.requests.map((r) => r.surface)).toEqual(['modal']);
    expect((f.requests[0].request as { outputTokenAddress: string }).outputTokenAddress).toBe(SHARE);
  });

  test('a plain pick across chains with no share there stays public', () => {
    const f = form({
      sendChainId: 10,
      getSwapOutputTokens: () => [{ address: OUTPUT }],
      isConfiguredShareTarget: () => false,
    });
    f.handoff();
    expect(f.state.privateSwapSend).toBe(false);
    expect(f.requests.map((r) => r.surface)).toEqual(['withdraw']);
  });

  test('a share on a destination the cross-chain reshield does not serve stays public', () => {
    const f = form({
      sendChainId: 56,
      getSwapOutputTokens: () => [{ address: OUTPUT }],
      isConfiguredShareTarget: () => true,
    });
    f.handoff();
    expect(f.state.privateSwapSend).toBe(false);
    expect(f.requests.map((r) => r.surface)).toEqual(['withdraw']);
  });

  test('the cross-chain private caption names the destination', () => {
    const f = form({ sendChainId: 10, getSwapOutputTokens: () => [{ address: OUTPUT }], isConfiguredShareTarget: () => true });
    const text = evaluate<string>(caption.expression!, f.state);
    expect(text).toContain('swapped and bridged, and deposited as a new shielded note for the recipient on Destination.');
    expect(text).not.toMatch(/[;\u2014]/);
  });

  test('a refusal keeps the form open, says so, and NEVER falls back to a public payout', () => {
    const f = form({ ...supported, modalAccepts: false });
    f.handoff();
    expect(f.requests.map((r) => r.surface)).toEqual(['modal']);
    expect(f.closes).toEqual([]);
    expect(f.errors).toEqual(["Couldn't open the private swap route. Reload and try again."]);
  });

  test('an unresolved recipient is not a private send either', () => {
    for (const recipientAddress of ['', 'alice.eth', '0x1234']) {
      const f = form({ ...supported, recipientAddress });
      f.handoff();
      expect(f.requests).toEqual([]);
      expect(f.errors).toEqual(['Enter a valid recipient address.']);
      expect(f.state.privateSwapSend).toBe(false);
    }
  });

  test('a send to yourself is still the Swap tab, whatever the list says', () => {
    const f = form({ ...supported, recipientAddress: OWN, recipientInput: OWN });
    f.handoff();
    expect(f.requests.map((r) => r.surface)).toEqual(['tab']);
    expect(f.state.privateSwapSend).toBe(false);
  });

  test('exactly one route copy shows at a time', () => {
    for (const outputs of [[], [{ address: OUTPUT }]]) {
      for (const recipient of [OWN, OTHER, '']) {
        const f = form({ getSwapOutputTokens: () => outputs, recipientAddress: recipient, recipientInput: recipient });
        const shown = [publicCopy, privateCopy, privateSendCopy].map((c) => evaluate<boolean>(c, f.state));
        expect(shown.filter(Boolean).length).toBeLessThanOrEqual(1);
        expect(shown[2]).toBe(recipient === OTHER && outputs.length > 0);
      }
    }
  });

  test('the caption promises a shielded note, not a wallet payout', () => {
    const f = form({ ...supported });
    const text = evaluate<string>(caption.expression!, f.state);
    expect(text).toContain('shielded note for the recipient');
    expect(text).toContain('Nothing is paid to a wallet');
    expect(text).not.toContain('on-chain');
  });
});

describe('ENS names (DEV-570: not supported, for privacy)', () => {
  test('a typed name is never looked up and never becomes a recipient', () => {
    const f = form({ recipientInput: 'alice.eth', recipientAddress: '' });
    let lookups = 0;
    evaluate<() => void>(ensEffect.arguments[0], {
      ...f.state,
      resolveEnsAddress: () => { lookups += 1; return Promise.resolve(OTHER); },
      ENS_UNSUPPORTED_MESSAGE: 'ENS unsupported',
    })();
    expect(lookups).toBe(0);
    expect(f.state.recipientAddress).toBe('');
    expect(f.state.resolvedRecipientName).toBeNull();
    expect(f.state.recipientEnsResolving).toBe(false);
    expect(f.state.recipientEnsError).toBe('ENS unsupported');
  });
});

describe('route copy and recipient-free reshields', () => {
  test('copy follows the actual route, including unresolved and unsupported selections', () => {
    for (const recipient of [OWN, OTHER, '']) {
      for (const sendChainId of [1, 10, 56]) {
        const f = form({ recipientAddress: recipient, recipientInput: recipient, sendChainId });
        const publicVisible = evaluate<boolean>(publicCopy, f.state);
        const privateVisible = evaluate<boolean>(privateCopy, f.state);
        expect(publicVisible && privateVisible).toBe(false);
        expect(publicVisible).toBe(recipient === OTHER);
        expect(privateVisible).toBe(recipient === OWN && sendChainId !== 56);
        const text = evaluate<string>(caption.expression!, f.state);
        if (recipient === OTHER) {
          expect(text).toContain('paid to the recipient on-chain');
          expect(text).not.toContain('shielded');
        } else if (recipient === '') expect(text).toContain('Enter a valid recipient');
        else if (sendChainId === 56) expect(text).toContain('not available');
        else expect(text).toContain('shielded');
      }
    }
  });
  test('the removed recipient lock has no remaining state or input wiring', () => {
    for (const name of ['swapSendLockRef', 'recipientBeforeSwapLockRef', 'wasSwapSendRef', 'readOnly={isSwapSend}']) {
      expect(TRANSFER).not.toContain(name);
    }
  });
  test('the Swap tab request may name a recipient, decided by the private route rule (DEV-510)', () => {
    const handoff = ts.createSourceFile('handoff.ts', HANDOFF, ts.ScriptTarget.Latest, true);
    const type = handoff.statements.find((node): node is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(node)
      && node.name.text === 'SwapTabHandoffRequest')!;
    expect(ts.isTypeLiteralNode(type.type)).toBe(true);
    expect((type.type as ts.TypeLiteralNode).members.map((member) => member.name?.getText(handoff))).toContain('recipient');
    expect(HUB).not.toContain('Use Withdraw to pay someone else.');
    expect(HUB).toContain('swapTabRecipientRoute({');
    expect(HUB).toContain('testID="hub-swap-recipient-input"');
  });
});

/**
 * The picker offers what the CHOSEN ROUTE can serve.
 *
 * A self-send is a reshield and its output has to be something a deposit can
 * land in. A third-party send is a payout and any deliverable asset will do.
 * Offering the payout list to both produced a cross-chain self-send that
 * validated, promised a new shielded note, and then refused at the button with
 * "Couldn't open the private swap route" because plain USDT on BNB is
 * deliverable to a wallet and is not a reshield target (2026-09-22).
 */
describe('the receive picker follows the route', () => {
  const SOURCE = readFileSync(
    join(new URL('.', import.meta.url).pathname, '..', '..', 'components', 'transfer-modal-provider.tsx'),
    'utf8',
  );
  const memo = (): string => {
    const at = SOURCE.indexOf('const receiveTokens = useMemo<SwapTokenInfo[]>');
    expect(at).toBeGreaterThan(-1);
    const end = SOURCE.indexOf('}, [receiveAsAvailable', at);
    expect(end).toBeGreaterThan(at);
    return SOURCE.slice(at, end);
  };

  test('a self-send is offered reshield targets, judged from the source chain', () => {
    expect(memo()).toContain('getSwapOutputTokens(sendChainId, chainId)');
  });

  test('a third-party send is offered the wider delivery list', () => {
    expect(memo()).toContain('thirdPartyReceiveTokens(sendChainId, chainId)');
  });

  // cubic on #251: the plain delivery list holds no share, so the private
  // cross-chain route was unreachable. Shares join it only across chains the
  // reshield serves, and plain assets stay for Withdraw.
  test('across a served pair a third party is also offered the destination shares', () => {
    const fn = find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node)
      && node.name?.text === 'thirdPartyReceiveTokens');
    const code = ts.transpileModule(fn.getText(source).replace(/^export /, ''), {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None },
    }).outputText;
    const SHARE = `0x${'5'.repeat(40)}`;
    const PLAIN = `0x${'4'.repeat(40)}`;
    const make = new Function('getSwapDeliveryTokens', 'getSwapOutputTokens', 'crossChainReshieldSupported', 'isConfiguredShareTarget',
      `${code}\nreturn thirdPartyReceiveTokens;`);
    const pick = make(
      () => [{ address: PLAIN }],
      () => [{ address: PLAIN }, { address: SHARE }],
      (_s: number, d: number) => d === 56,
      (a: string) => a === SHARE,
    );
    expect(pick(56, 1).map((t: { address: string }) => t.address)).toEqual([PLAIN, SHARE]);
    expect(pick(10, 1).map((t: { address: string }) => t.address)).toEqual([PLAIN]);
    expect(pick(1, 1).map((t: { address: string }) => t.address)).toEqual([PLAIN]);
  });

  test('the choice is made from the recipient, not from the chain alone', () => {
    const body = memo();
    expect(body).toContain('connectedAddress');
    expect(body).toContain('recipientAddress.trim().toLowerCase()');
  });

  test('the memo re-runs when the recipient changes', () => {
    const at = SOURCE.indexOf('const receiveTokens = useMemo<SwapTokenInfo[]>');
    const deps = SOURCE.slice(SOURCE.indexOf('}, [receiveAsAvailable', at), SOURCE.indexOf(');', SOURCE.indexOf('}, [receiveAsAvailable', at)));
    expect(deps).toContain('recipientAddress');
    expect(deps).toContain('connectedAddress');
  });

  test('switching network defaults to a token the route can serve', () => {
    const callback = find((node): node is ts.JsxAttribute => ts.isJsxAttribute(node)
      && node.name.getText(source) === 'onSelectNetwork').initializer as ts.JsxExpression;
    const invalidation = effect('useEffect', 'noLongerOffered');
    for (const own of [false, true]) {
      for (const chainId of [1, 56]) {
        const destination = chainId === 1 ? 56 : 1;
        const privateOutput = { address: OTHER, symbol: 'ppUSDT', decimals: 18 };
        const publicOutput = { address: THIRD, symbol: 'USDT', decimals: 18 };
        const state: Record<string, any> = {
          chainId, sendChainId: chainId, sendDestinations: [1, 56], receiveAsAvailable: true,
          selectedTokenId: INPUT, selectedSymbol: 'ppETH', selectedDecimals: 18,
          isSameAsset: (address: string) => address.toLowerCase() === INPUT,
          connectedAddress: OWN, recipientAddress: own ? OWN : OTHER, sendsToOwnAccount: own,
          useMemo: (fn: () => unknown) => fn(),
          getSwapOutputTokens: (id: number) => id === destination ? [privateOutput] : [],
          getSwapDeliveryTokens: (id: number) => id === destination ? [publicOutput] : [],
          thirdPartyReceiveTokens: (id: number) => state.getSwapDeliveryTokens(id),
          NATIVE_ASSET_ADDRESS: OUTPUT, preferredReceiveAsset, pickPoolChainRef: { current: chainId },
        };
        state.setSendChainId = (id: number) => { state.sendChainId = id; };
        state.setReceiveAsset = (asset: unknown) => { state.receiveAsset = asset; };
        state.receiveTokens = evaluate(initializer('receiveTokens'), state);
        evaluate<(id: number) => void>(callback.expression!, state)(destination);
        state.receiveTokens = evaluate(initializer('receiveTokens'), state);
        state.crossChainSend = true;
        evaluate<() => void>(invalidation.arguments[0], state)();
        expect(state.receiveAsset).toEqual(own ? privateOutput : publicOutput);
        // Returning to the pool chain restores an ordinary private send.
        evaluate<(id: number) => void>(callback.expression!, state)(chainId);
        expect(state.receiveAsset).toBeNull();
      }
    }
  });
});

/**
 * A pick that is no longer offered is dropped.
 *
 * Narrowing the list was not enough. `receiveTokens` narrows when the recipient
 * becomes your own account, because a self-send is a reshield and can only land
 * where a deposit can reach. Picking USDT on BNB with the recipient still empty
 * and then typing your own address left USDT SELECTED while the list behind it
 * had become [BNB, FDUSD]: the form promised a shielded note and the button
 * refused with "Couldn't open the private swap route" (QA, 2026-09-22).
 */
describe('the receive selection is revalidated, not just the list', () => {
  const SOURCE = readFileSync(
    join(new URL('.', import.meta.url).pathname, '..', '..', 'components', 'transfer-modal-provider.tsx'),
    'utf8',
  );

  /** The single effect that invalidates a receive pick, for both reasons. */
  const effect = (): string => {
    const at = SOURCE.indexOf('  // One place decides that a pick is no longer valid');
    expect(at).toBeGreaterThan(-1);
    const end = SOURCE.indexOf('}, [receiveAsset, isSameAsset, selectedSymbol, crossChainSend, receiveTokens, chainId]);', at);
    expect(end).toBeGreaterThan(at);
    return SOURCE.slice(at, end);
  };

  const invalidation = find((node): node is ts.CallExpression => ts.isCallExpression(node)
    && ts.isIdentifier(node.expression) && node.expression.text === 'useEffect'
    && node.arguments[0].getText(source).includes('noLongerOffered'));
  type Pick = { address: string; symbol?: string };
  const revalidate = (asset: Pick | null, offered: Pick[], crossChainSend = false, selectedSymbol = 'ETH', lastPoolChain = 1) => {
    let selected: Pick | null = asset;
    evaluate<() => void>(invalidation.arguments[0], {
      receiveAsset: asset, receiveTokens: offered.map((t) => ({ symbol: '', ...t })), selectedTokenId: INPUT,
      isSameAsset: (address: string) => address.toLowerCase() === INPUT,
      selectedSymbol, crossChainSend, preferredReceiveAsset, chainId: 1, pickPoolChainRef: { current: lastPoolChain },
      setReceiveAsset: (value: Pick | null) => { selected = value; },
    })();
    return selected;
  };

  test('one effect owns invalidation, so the two rules cannot drift apart', () => {
    // Other sites clear the pick too (opening the form, changing chain); those
    // are resets, not invalidation. What must stay single is the EFFECT keyed
    // on the offered list — a second one would be a second set-state-in-effect
    // for the same state, and a second place for the rules to disagree.
    expect(SOURCE.split('receiveTokens, chainId]);').length - 1).toBe(1);
  });

  test('it drops a pick that became the input asset, same chain only', () => {
    const body = effect();
    expect(body).toContain('!crossChainSend && isSameAsset(address)');
    const input = { address: INPUT };
    expect(revalidate(input, [input])).toBeNull();
    expect(revalidate(input, [input], true)).toBe(input);
  });

  test('it drops a pick the list no longer offers', () => {
    const body = effect();
    expect(body).toContain('receiveTokens.some(');
    expect(body).toContain('noLongerOffered');
    expect(revalidate({ address: OUTPUT }, [{ address: OTHER }])).toBeNull();
    const picked = { address: OTHER };
    expect(revalidate(picked, [picked])).toBe(picked);
  });

  test('across chains a dropped pick is replaced, keeping the coin, never left empty', () => {
    // Pat, 2026-09-25: USDT to BNB. Plain USDT was picked, the list narrowed to
    // the reshield targets, and the cleared pick left the card showing "USDT"
    // under BNB while Review refused instead of handing off to Swap.
    const fdusd = { address: OUTPUT, symbol: 'FDUSD' };
    const share = { address: OTHER, symbol: 'ppUSDT' };
    expect(revalidate({ address: THIRD, symbol: 'USDT' }, [fdusd, share], true))
      .toEqual({ address: OTHER, symbol: 'ppUSDT' });
    // Nothing picked yet on another chain: take the input's coin if offered.
    expect(revalidate(null, [fdusd, share], true, 'USDT')).toEqual({ address: OTHER, symbol: 'ppUSDT' });
    // Same chain, nothing picked is an ordinary private send and stays so.
    expect(revalidate(null, [fdusd, share], false, 'USDT')).toBeNull();
  });

  test('the commit where the pool chain changed leaves the reset alone (cubic, #149)', () => {
    // The reset effect cleared the pick in this same commit; this effect still
    // sees the old destination and must not re-fill it.
    const share = { address: OTHER, symbol: 'ppUSDT' };
    expect(revalidate(null, [share], true, 'USDT', 56)).toBeNull();
    expect(revalidate({ address: THIRD, symbol: 'USDT' }, [share], true, 'USDT', 56)).toEqual({ address: THIRD, symbol: 'USDT' });
  });

  test('it matches case-insensitively, because addresses arrive both ways', () => {
    expect(effect()).toMatch(/toLowerCase\(\)[\s\S]*toLowerCase\(\)/);
    const picked = { address: OTHER.toUpperCase() };
    expect(revalidate(picked, [{ address: OTHER.toLowerCase() }])).toBe(picked);
  });

  test('an empty list is not treated as "nothing is offered"', () => {
    // receiveTokens is [] while the swap route is unavailable on this network;
    // clearing there would wipe a pick the user must then make again for nothing.
    expect(effect()).toContain('receiveTokens.length === 0');
    for (const address of [INPUT, OUTPUT]) {
      const picked = { address };
      expect(revalidate(picked, [])).toBe(picked);
      expect(revalidate(picked, [], true)).toBe(picked);
    }
  });

  test('it re-runs when the pick, the input or the list changes', () => {
    expect(SOURCE).toContain('}, [receiveAsset, isSameAsset, selectedSymbol, crossChainSend, receiveTokens, chainId]);');
  });
});
