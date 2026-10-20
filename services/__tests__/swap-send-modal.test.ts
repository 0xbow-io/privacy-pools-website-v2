/**
 * The swap modal's private swap-send wiring (reshield-and-transfer, v2-monorepo
 * #439): a same-chain reshield whose recipient is another REGISTERED account.
 *
 * Source-level on purpose, like fallback-field-copy.test.ts: the thing worth
 * pinning is WHICH values each step reads, and a render test would have to
 * reproduce the Expo / wagmi / pools tree to see it. The sequencing and the
 * service calls are executed for real in swap-flows.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { saveSwapSendDraft, takeSwapSendDraft, clearSwapSendDraft } from '../swap-handoff';
import { swapSendUnregisteredNotice } from '../recipient-registration-hint';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
const source = readFileSync(join(ROOT, 'components/swap-modal-provider.tsx'), 'utf8');
const flows = readFileSync(join(ROOT, 'services/swap-flows.ts'), 'utf8');

/** The text between two markers, failing loudly if either moved. */
function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  expect(start).toBeGreaterThan(-1);
  const end = text.indexOf(to, start);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

const estimate = between(source, 'const getReshieldEstimate = useCallback', 'const getReshieldEstimateRef');
const confirm = between(source, 'const confirmReshieldUnlocked = useCallback', 'const confirmReshield = useMemo');

describe('Review: a registered recipient discovers the note, an unregistered one gets a claim link automatically', () => {
  test('Review runs for registered and unregistered alike, with no tick to opt in (Mike, DEV-511)', () => {
    expect(source).toContain("&& (!swapSend || swapSendRegistration === 'registered' || swapSendRegistration === 'unregistered')");
    expect(source).not.toContain('claimLinkOptIn');
    expect(source).not.toContain('swap-send-claim-optin');
  });

  test('a swap-send is same chain off the hub Swap tab (or the Send tab inline), or a cross-chain send handoff, and not to yourself', () => {
    expect(source).toContain('const sameChainReshield = isReshield && destinationChainId === chainId;');
    // DEV-510: the hub Swap tab's recipient row sets sendHandoff via syncInlineForm,
    // so the same registration gate and reshield-transfer route apply to it.
    const sync = between(source, 'const syncInlineForm = useCallback', '// --- Form edit helpers');
    expect(sync).toMatch(/if \(typed\) \{\s*setRecipient\(typed\);\s*setSendHandoff\(true\);/);
    expect(source).toContain('const modalRecipientField = (sameChainReshield && (!inlineHubActive || inlineSend || sendHandoff)) || crossChainSendField;');
    // Across chains the field is the FALLBACK unless the Send tab handed off a
    // recipient: typing in the plain Swap form never gives the note away.
    expect(source).toContain('const crossChainSendField = crossChainReshield && sendHandoff;');
    expect(source).toContain("setSendHandoff(!!handedOffRecipient && options?.mode === 'reshield');");
    // Inline only when it was opened with a recipient for a private reshield,
    // so the hub Swap tab never grows a third-party recipient by accident.
    expect(source).toContain("setInlineSendPreferred(!!options?.inline && !!options?.recipient?.trim() && options?.mode === 'reshield');");
    expect(source).toMatch(/const thirdPartyRecipient = modalRecipientField && recipientValid\s*&& !ownAddresses\.includes\(trimmedRecipient\.toLowerCase\(\)\);/);
    // Both identities count as "you": the wallet and the signed-in session.
    expect(source).toMatch(/\[address, sessionAddress\]/);
  });

  test('registration is asked again at Review, before any note is selected or proved', () => {
    // Asked where the note lands: the destination chain for a cross-chain send.
    expect(estimate).toContain('const registrationChain = requestDestination !== chainId ? requestDestination : chainId;');
    const check = estimate.indexOf('checkRecipientRegistration(registrationChain, requestSendTo');
    const notes = estimate.indexOf('selectApprovedNotes(requestFromToken');
    expect(check).toBeGreaterThan(-1);
    expect(notes).toBeGreaterThan(check);
  });

  test('unregistered takes the claim-link route; a failed lookup still stops', () => {
    expect(estimate).toMatch(/if \(registration === 'unregistered'\) \{\s*requestBlind = true;\s*\} else if \(registration !== 'registered'\) \{/);
    expect(estimate).toContain('Couldn’t check whether this address can receive a private swap.');
    expect(estimate).toContain('...(requestSendTo && requestBlind ? { recipientBlind: true } : {})');
  });

  test('the why is said once, and a registered recipient is told no link is needed', () => {
    expect(source).toContain("export const SWAP_SEND_NO_CLAIM = 'No claim link needed. They\\u2019ll find it automatically.';");
    expect(source).toContain('`${swapSendUnregisteredNotice(getChainConfig(swapSendChainId)?.displayName)} ${SWAP_SEND_CLAIM_WHY}`');
    expect(source).toContain('{reshieldSnapshot.recipientBlind ? SWAP_SEND_CLAIM_WHY : SWAP_SEND_NO_CLAIM}');
    expect(source).toContain('testID="swap-send-success-no-claim"');
  });

  test('cross-chain: registration is checked on the DESTINATION chain and the notice names it (Mike, DEV-511)', () => {
    // Live form check and the Review re-check both key on where the note lands.
    expect(source).toContain('const swapSendChainId = crossChainReshield ? destinationChainId : chainId;');
    expect(source).toContain('const swapSendKey = swapSend && isCheckableRecipient(trimmedRecipient)\n    ? `${swapSendChainId}:${trimmedRecipient.toLowerCase()}`');
    expect(estimate).toContain('const registrationChain = requestDestination !== chainId ? requestDestination : chainId;');
    expect(source).toContain('swapSendUnregisteredNotice(getChainConfig(swapSendChainId)?.displayName)');
    // Registered on Ethereum only, sending to BNB Chain: the notice is about BNB Chain.
    expect(swapSendUnregisteredNotice('BNB Chain')).toBe('This address doesn’t have a Privacy Pools account on BNB Chain. You’ll get a claim link to send them.');
  });

  test('a failed or fallback-paid delivery voids the link and its leave guard', () => {
    expect(source).toContain("const claimLinkVoid = delivery?.status === 'recovered' || delivery?.status === 'failed';");
    expect(source).toContain('!claimLinkVoid && needsLeaveConfirm(');
  });
});

describe('what the form typed in the field means', () => {
  // Showing a recipient field means what is typed in it is honoured or refused,
  // never ignored: a reshield that quietly paid the user's own account while the
  // field named someone else would be the worst version of this feature.
  test('a third party needs a chosen output, and every offered output is one the route takes', () => {
    // The form only offers reshield targets, and reshield-and-transfer serves all
    // of them (a yield share or a plain asset, v2-monorepo #472).
    // Same chain: any chosen output. Across chains (reshield-and-transfer-
    // crosschain) only a configured yield share on the destination.
    expect(source).toContain('const swapSendOutputOk = !!outputToken\n    && (!crossChainReshield || crossChainSendOutputSupported(outputToken.token.address, destinationChainId));');
    expect(source).toContain('const swapSend = thirdPartyRecipient && swapSendOutputOk;');
    expect(source).not.toContain('isConfiguredShareTarget');
  });

  test('Review is held for a third party the route cannot serve, and says why', () => {
    expect(source).toMatch(/&& \(!thirdPartyRecipient \|\| swapSendOutputOk\)/);
    expect(source).toContain('This asset can’t be sent privately to another address yet.');
  });

  test('text in the field that is not an address never becomes a quiet reshield to yourself', () => {
    expect(source).toContain("const recipientTypedButInvalid = modalRecipientField && trimmedRecipient !== '' && !recipientValid;");
    expect(source).toContain('&& !recipientTypedButInvalid');
  });

  test('an inconclusive registration lookup is retried, not cached as final', () => {
    // 'unknown' is an RPC or ASP blip. Review is disabled while it stands, so
    // without a retry the only way out was editing the address (review of #219).
    const effectBody = between(source, 'const swapSendAttemptsRef', 'const swapSendRegistration:');
    expect(effectBody).toContain("if (result === 'unknown' && swapSendAttemptsRef.current.count < 4)");
    expect(effectBody).toContain('setSwapSendRetry((n) => n + 1)');
    // Bounded, and the count restarts per address.
    expect(effectBody).toContain('swapSendAttemptsRef.current.key !== swapSendKey');
    expect(effectBody).toContain('[swapSendKey, swapSendRetry, isOpen]');
    // A closed modal makes no lookups, retries included (review of #219).
    expect(effectBody).toContain('if (!swapSendKey || !isOpen) return;');
  });
});

describe('what the sender is bound to', () => {
  test('the recipient is captured with the request and keys the in-flight guard', () => {
    expect(estimate).toContain('const requestSendTo = swapSend ? (trimmedRecipient as Address) : undefined;');
    expect(estimate).toContain("recipient: requestSendTo ? requestSendTo.toLowerCase() : 'self'");
  });

  test('the snapshot freezes it, and Confirm reads the snapshot, never the live form', () => {
    expect(estimate).toContain('...(requestSendTo ? { recipient: requestSendTo } : {})');
    expect(confirm).toContain('snap.recipient');
    expect(confirm).not.toContain('trimmedRecipient');
  });

  test('Review prices it with the transfer estimate', () => {
    expect(estimate).toContain('...(requestSendTo ? { transfer: true } : {})');
  });

  test('the recipient reaches the SDK as a registered account or the blind form, never as an out-of-band claim', () => {
    expect(confirm).toContain('recipient: sameBlind ? sameBlind.recipient : { discoveryData: { evmAddress: snap.recipient } }');
    // Setting this would hand the sender a secret to deliver AFTER the swap ran.
    expect(source).not.toContain('allowOutOfBandFallback');
    expect(flows).not.toMatch(/allowOutOfBandFallback:\s*true/);
  });

  test('the recipient\'s note is never stored as the sender\'s', () => {
    // runReshield returns no pendingNote for a transfer (swap-flows.test.ts), and
    // the only addNotes call in Confirm is gated on there being one.
    const gate = confirm.indexOf('if (pendingNote?.isOwned && hash)');
    expect(gate).toBeGreaterThan(-1);
    expect(flows).toContain('...(!transfer && depositResult?.pendingNote');
  });
});

describe('the Send tab hosts the private swap-send', () => {
  const hub = readFileSync(join(ROOT, 'components/home/action-hub.tsx'), 'utf8');
  test('an executing swap-send locks the tabs and the auto-open, even as a sheet', () => {
    expect(hub).toContain("const swapExecuting = (swapInline || swapInlineSend) && swapStep === 'executing';");
    expect(hub).toMatch(/const tabsDisabled = [^;]*\|\| swapExecuting;/);
    expect(hub).toContain('if (!inlineOps || txPending || pickerOpen || swapExecuting) return;');
  });
  test('a settled swap-send clears the Send amount before the form reopens', () => {
    expect(hub).toMatch(/if \(swapInlineSend && swapStep === 'success'\) \{\s*setAmountFor\('send', ''\);\s*clearSwapSendDraft\(\);/);
  });
});

describe('leaving a swap-send that did not settle', () => {
  const transfer = readFileSync(join(ROOT, 'components/transfer-modal-provider.tsx'), 'utf8');
  const asset = { symbol: 'ppETH', address: '0xabc', decimals: 18 };
  test('the Send form gets its recipient and "receive as" back, once, on the same chain', () => {
    saveSwapSendDraft({ owner: '0xAlice', chainId: 56, recipient: '0xBob', sendChainId: 56, receiveAsset: asset });
    expect(takeSwapSendDraft(1, '0xalice')).toBeNull();
    saveSwapSendDraft({ owner: '0xAlice', chainId: 56, recipient: '0xBob', sendChainId: 56, receiveAsset: asset });
    expect(takeSwapSendDraft(56, '0xALICE')).toEqual({ owner: '0xalice', chainId: 56, recipient: '0xBob', sendChainId: 56, receiveAsset: asset });
    expect(takeSwapSendDraft(56, '0xalice')).toBeNull();
    saveSwapSendDraft({ owner: '0xAlice', chainId: 56, recipient: '0xBob', sendChainId: 56, receiveAsset: asset });
    clearSwapSendDraft();
    expect(takeSwapSendDraft(56, '0xalice')).toBeNull();
    saveSwapSendDraft({ owner: '0xAlice', chainId: 56, recipient: '0xBob', sendChainId: 56, receiveAsset: asset });
    expect(takeSwapSendDraft(56, '0xcarol')).toBeNull();
    expect(takeSwapSendDraft(56, '0xalice')).toBeNull();
    saveSwapSendDraft({ owner: '0xAlice', chainId: 56, recipient: '0xBob', sendChainId: 56, receiveAsset: asset });
    expect(takeSwapSendDraft(56, null)).toBeNull();
  });
  test('the hand-off saves the draft and the inline reopen restores it instead of the sent token', () => {
    expect(transfer).toContain('if (inlineBase && currentIdentityRef.current) saveSwapSendDraft({ owner: currentIdentityRef.current, chainId, recipient: recipientInput.trim() || recipientAddress, sendChainId, receiveAsset });');
    expect(transfer).toContain('takeSwapSendDraft(chainId, currentIdentityRef.current)');
    expect(transfer).toMatch(/draftIdentitySeenRef.current = draftIdentity;\s*clearSwapSendDraft\(\);/);
    expect(transfer).toContain('swapSendDraft?.recipient ?? prefill?.recipient?.trim()');
    expect(transfer).toContain('setReceiveAsset(swapSendDraft?.receiveAsset ?? null);');
  });
});

describe('cross-chain private swap-send (reshield-and-transfer-crosschain)', () => {
  test('the fallback for a send is the sender wallet, never the recipient', () => {
    expect(estimate).toContain('fallbackForReview = (requestSendTo ? address : (trimmedRecipient || address)) as Address;');
  });

  test('Review prices the transfer estimate, and refuses a plain output first', () => {
    const refuse = estimate.indexOf('!crossChainSendOutputSupported(requestOutputToken.address, requestDestination)');
    const priced = estimate.indexOf('estimateReshieldTransferCrosschainAmount');
    expect(refuse).toBeGreaterThan(-1);
    expect(priced).toBeGreaterThan(refuse);
  });

  test('Confirm hands the reviewed recipient to the cross-chain run', () => {
    const cross = between(confirm, 'runReshieldCrosschain(', 'const crossHash');
    expect(cross).toContain('recipient: crossBlind ? crossBlind.recipient : { discoveryData: { evmAddress: snap.recipient } }');
  });

  test('the registration lookup follows the chain the note lands on', () => {
    expect(source).toContain('const swapSendChainId = crossChainReshield ? destinationChainId : chainId;');
    expect(source).toContain('`${swapSendChainId}:${trimmedRecipient.toLowerCase()}`');
  });

  test('the sender needs no account on the destination for a send (cubic on #251)', () => {
    expect(source).toContain('if (crossChainReshield && !swapSend) {');
  });

  test('a delivered cross-chain send reads as done, not pending', () => {
    expect(source).toContain("reshieldSnapshot.recipient && delivery?.status === 'done'");
  });
});
