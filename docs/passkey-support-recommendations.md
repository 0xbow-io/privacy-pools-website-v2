# Privacy Pools: a support case involving Mac Touch ID, a phone passkey, and a missing balance

## TL;DR

1. After depositing on Base, the user saw transaction history but no private balance.
2. Mac Touch ID signed in successfully, but Base showed **Different unlock**.
3. Syncing did not help. Note export also got stuck on **Preparing…**.
4. Canceling the Touch ID prompt exposed Chrome’s phone-passkey option.
5. Using the original phone passkey restored the balance and **Registered** status. No withdrawal was confirmed.
6. Improve unlock guidance, export errors, and deposit checks. The export hang remains unexplained.

**Status:** proposed recommendations, not an implementation or release commitment.

**Report date:** October 24, 2026 UTC. **Scope:** one anonymized support case and a source review of website version 1.2.1, commit `c9583b030882645169e5ef1a127cb470fd228bab`.

The user recovered visibility of their balance and confirmed Base showed **Registered** after canceling the Mac Touch ID prompt and selecting their original phone passkey. No withdrawal or transfer was observed or confirmed during this conversation. The note-export hang remains unexplained. A separate source audit reproduced a deposit-safety gap; it is not established as the cause of this user's deposit or sign-in problem.

This report omits the user's name, chat identifiers, wallet addresses, transaction hashes, precise balance, screenshots, and all recovery material. It summarizes the conversation rather than publishing the private transcript.

## What happened

The user reported depositing through a Binance wallet on Base. Their transaction history remained visible, but their private balance did not appear and they could not withdraw or transfer. They described unsuccessful wallet attempts before using a passkey through a QR code scanned with their phone. Those initial failures were not captured in logs, so their exact cause is unknown.

The activity row was labeled **Deposit to recipient**, although the user believed they had shielded to their own account. That label sent the investigation toward recipient selection and payment requests before the registration screen established the more useful clue: Base showed **Different unlock**.

The user tried signing in and syncing without seeing the balance. They described wallet connection, a message signature, and a subsequent passkey prompt as a single two-step login. Terms such as key, passkey, security key, and account key were difficult to distinguish in the conversation.

Support then explored note export as a possible recovery route. Instructions initially said Actions → Export Notes; on their desktop the entry point was a wallet-address menu, and the actual path included **Privacy & keys**. The user needed additional guidance to find it and asked whether to click **Generate Backup**. The export subsequently displayed **Preparing…** for roughly three minutes and was still stuck in a later reply. Password encryption appeared unchecked in the earlier screenshot. A team member independently tested unencrypted export and reported that it completed instantly; the user's hang was not reproduced.

A redacted debug export was offered. The user was uncomfortable with a potential security risk to their computer or wallet and asked for another way. Support made diagnostics optional and continued without receiving a dump, note backup, or key.

The browser was **Chrome on a Mac**, not Binance's embedded browser. The original authentication had used the phone through QR scanning; the later attempt used **Mac Touch ID**. The user expected the shared Apple ID to make those equivalent. A screenshot showed an Apple sign-in prompt for an existing Privacy Pools passkey, but credential identifiers and PRF outputs were not collected.

The user said the website no longer displayed a QR code. Canceling only the Touch ID prompt exposed Chrome's phone option. They selected their phone, approved the passkey there, and reported that the balance now displayed correctly. They subsequently confirmed Base showed **Registered**.

Approximately 96 minutes elapsed between the initial support complaint and confirmation of the matching registration. This is elapsed conversation time, not a measurement of continuous troubleshooting or engineering work.

Afterward, the user requested Chinese language support, clearer notifications when deposits or wallet operations fail, and an easier way to participate. They were invited to report bugs, contribute code or PRs, and potentially validate a future Chinese translation. The user subsequently volunteered to validate the accuracy and naturalness of a future Chinese translation and asked to be contacted when it is ready for review. No translation schedule, paid role, or incentive was promised.

## Issues encountered and improvements

| Issue | What the case established | Recommended improvement |
|---|---|---|
| Initial deposit/wallet failures | The user reported several unsuccessful attempts before using a passkey. The errors were not captured. | Give each failure a short explanation, whether any transaction was submitted, and one relevant next step. Retain a local, redacted error reference. Do not blame a wallet without evidence. |
| History visible, private balance empty | Seeing the transaction convinced the user they were in the correct private account. Sync did not resolve the mismatch. | Explain that wallet activity and unlocked private balances are different views. When registration is incompatible, show an account-access warning prominently rather than letting an empty balance look like missing funds. Do not claim a deposit belongs to the active unlock solely from its payer address. |
| Ambiguous activity ownership | Deposit to recipient suggested a different recipient, but the user said they used their own account. Its classification was not conclusively diagnosed. | Investigate the classification separately. Display ownership only when established, and use neutral wording when it is unknown. Add tests for self-shielding, explicit self-recipient, another recipient, payment requests, and imported claim records. |
| Recipient access expectations | A separate review found that the unregistered-recipient hint exists, but an already registered recipient receives no equivalent explanation that the recipient account must unlock to access the funds. This was not established as the cause of this case. | Before submission, briefly explain who will receive and control the note. For an unregistered recipient, explain the private claim route. Do not infer account access from an address being registered. |
| Different unlock warning without a usable route | The user could read the warning but did not know how to switch to the correct unlock. | Put a short explanation and recovery action beside the warning. Example: **This unlock doesn't match your Base account. Try your original passkey.** Follow with browser-specific help where needed. |
| Successful authentication mistaken for correct account access | Mac Touch ID succeeded, yet the Base registration remained incompatible. | Distinguish passkey authentication success from a matching registered private identity. Check compatibility before presenting the account as ready to transact. |
| Wallet connection and private unlock blended together | The user understood signing and passkey approval as one login sequence. | Use short, consistent labels: **Connect wallet** and **Unlock private balance**. Explain a fallback when it is offered, and preserve the reason locally for troubleshooting. |
| Phone passkey versus Mac Touch ID confusion | The phone path restored visibility and compatibility; the Mac path had not. | Tell users to select their existing account passkey and provide a **Use another device** help action. Do not imply Touch ID is universally wrong or that all phone and Mac passkeys are different. |
| QR recovery hidden behind Cancel | Canceling the preferred Mac prompt exposed the phone option and led to recovery. | Explain this before a failed attempt becomes a support case: **Need your phone? Cancel the Touch ID prompt, then choose the phone option if Chrome offers it.** Label cancellation as non-destructive and avoid opening another prompt automatically. |
| Export menu difficult to find | Actions did not match the desktop label, and the Privacy & keys submenu was omitted initially. | Use the same menu name across layouts or provide a direct recovery action from the incompatible-account warning. Keep help instructions aligned with the actual menu hierarchy. |
| Export did not communicate readiness | The user had to ask whether Generate Backup was the next action. | State what the action does and show note count when known. Distinguish **No notes in this unlock** from a storage failure. A zero-note export is not proof that funds are lost. |
| Export remained Preparing | The user reported a multi-minute wait; the cause remains unconfirmed. | Add bounded waiting, a recoverable error, and local stage diagnostics. Keep close/cancel usable, preserve storage, and prevent a pending attempt from leaving stale busy state after a reopen or context change. Never silently discard recovery data. |
| Debug export felt unsafe | The user declined because they did not understand the risk. | Make support diagnostics a small, optional flow with a preview and explicit redaction. Default support sharing to the strongest privacy level. State clearly that a debug report is different from a note backup. |
| Language and onboarding friction | The user explicitly requested Chinese and better failure prompts. | Translate the access, deposit, recovery, and error flows first. Ask native speakers to validate terminology and actual tasks, including the OS/browser prompts they encounter. Keep recovery instructions short. |

## What the code review established

### The deposit guard exists, but permits unknown results

The website still compares the active unlock's nullifying-key hash with the account's on-chain registration. A confirmed mismatch is rejected. However, `resolveKeystoreIdentityStatus` catches lookup errors and returns `unknown`; `assertCanDeposit` rejects only `incompatible`. It can therefore allow a deposit after an RPC failure, even if the UI previously held an incompatible result. The destination-session builder has the same permissive behavior for transaction sessions. Discovery-only sessions deliberately skip this check and must retain their separate behavior.

Six focused tests executed the current production resolver and guard with injected dependencies. They confirmed: matching registration passes, unregistered accounts pass to the registration flow, a confirmed mismatch is blocked, a wrong write chain is blocked, an RPC timeout passes despite a prior incompatible UI state, and missing chain configuration also passes as unknown.

The bundled SDK 1.0.2 deposit preparation builds the note and proof without a second active-unlock-versus-registration check. The website therefore should not rely on that SDK path to close this gap. The behavior was already present in the initial public import; the guard was not recently removed.

**Recommended safety change:** refuse an own-account deposit when compatibility cannot be established. Keep sign-in and read-only discovery available. Give a short retryable error, such as **Couldn't verify this account. Nothing was deposited. Try again.** Preserve legitimate first registration and guard the identity that owns the new note, rather than blindly treating the payer as the recipient. Cover direct, yield, swap-and-deposit, destination-chain, and registration-handoff paths, including changes of wallet, unlock, or network during asynchronous work.

This is a verified gap, not proof that this user deposited under an incompatible unlock or that exploiting it caused their incident. No patch or deployment is included in this report.

### The export spinner points to local work, not a relayer quote

In the reviewed EVM export path, the Preparing state begins after the current account export has been resolved. The unencrypted backup path then reads the locally stored payment-request recovery state and serializes the backup. Password encryption additionally uses PBKDF2 and AES-GCM. This section does not call the relayer or ASP or request a wallet signature.

That narrows the investigation but does not identify the hang. Possible areas to investigate include stale UI state, unusually large local recovery data, a stalled browser process, and a different client build. None is confirmed. Record stage, duration, payload size/counts, and build information locally without recording backup contents or keys. If a timeout is introduced, stop waiting in the UI without deleting or overwriting the underlying data; guard against late completion updating a different session.

### The exact cross-device identity cause remains unknown

The observed difference was between a Mac Touch ID route and the original phone route. We did not collect credential IDs, PRF results, or secrets, so we cannot conclude whether the browser selected different credentials or another derivation/provider difference occurred. A synced passkey can be used on multiple devices; device type alone is not an identity identifier.

The app already attempts credential-specific passkey requests where it has a stored credential ID. Investigate the local credential marker, owner and relying-party bindings, PRF input consistency, and provider behavior using test accounts. Do not work around the problem by silently creating a new credential, replacing account keys, or relaxing compatibility checks.

## A shorter support flow

1. Establish browser, network, connected wallet, and current registration label. Avoid an export detour before identifying an unlock mismatch.
2. If history is visible but the balance is empty and the label says Different unlock, explain the mismatch before asking the user to sync repeatedly.
3. Ask how the original passkey was approved and how the current one was approved. A phone QR prompt and Mac Touch ID are concrete descriptions; account key and security key were ambiguous in this case.
4. Offer the original existing credential path. In this case, canceling only the Mac authentication prompt exposed Chrome's phone option. Never recommend deleting passkeys or clearing browser data to force that chooser.
5. Confirm both balance visibility and Registered status. Do not claim a withdrawal completed without evidence.
6. Use note recovery or optional redacted diagnostics when still necessary, with explicit limits on what they can establish. Offer an alternative if the user declines sharing diagnostics.

Our initial support instructions could have been clearer: the menu path was incomplete, sync advice preceded a firm identity diagnosis, and note export introduced a second unresolved issue. Asking the concrete phone-versus-Mac question earlier would likely have shortened this case, although that counterfactual cannot be measured.

## Suggested implementation order and validation

**First:** close the unknown-compatibility deposit gap and add behavior tests around real transaction entry points. Preserve discovery and legitimate recipient funding. Run the repository's privacy checks for any transaction-path change; do not add user-note identifiers or new UI-triggered network requests to diagnose access problems.

**Next:** make the incompatible-unlock state prominent and actionable, add concise phone-passkey guidance, and make export failures bounded and recoverable. Keep the design small: an inline warning, one help action, and an export status/error are enough to begin.

**Then:** improve activity ownership wording, add Chinese translations with native-speaker validation, and simplify optional diagnostic sharing.

Validate with test accounts across Chrome on Mac using local Touch ID and a phone QR flow; existing and unavailable credentials; synchronized and distinct credentials; canceled prompts; supported wallet-signature and passkey fallback flows; incompatible and unreachable registrations; and delayed, empty, large, or failed local exports. Assert that canceling never registers or deletes an identity, unknown compatibility cannot authorize a deposit, secrets never enter support exports, and browser data survives failed recovery attempts.

A reasonable usability acceptance test is that a new user can explain the mismatch and reach the original credential chooser without a support agent or private-data sharing. Measure local task completion in usability sessions; do not introduce account-linked telemetry to measure it.

## References

All website references below are pinned to the reviewed version, rather than a moving branch:

- [Identity resolver and deposit guard](https://github.com/0xbow-io/privacy-pools-website-v2/blob/c9583b030882645169e5ef1a127cb470fd228bab/components/sdk-provider.tsx) — `resolveKeystoreIdentityStatus`, `assertCanDeposit`, and `buildSessionForChain`.
- [Recipient registration hints](https://github.com/0xbow-io/privacy-pools-website-v2/blob/c9583b030882645169e5ef1a127cb470fd228bab/services/recipient-registration-hint.ts).
- [Deposit entry points](https://github.com/0xbow-io/privacy-pools-website-v2/blob/c9583b030882645169e5ef1a127cb470fd228bab/components/deposit-modal-provider.tsx).
- [Account backup UI](https://github.com/0xbow-io/privacy-pools-website-v2/blob/c9583b030882645169e5ef1a127cb470fd228bab/components/account-recovery-modal-provider.tsx) and [backup core](https://github.com/0xbow-io/privacy-pools-website-v2/blob/c9583b030882645169e5ef1a127cb470fd228bab/services/account-backup-core.ts).
- [Passkey requests](https://github.com/0xbow-io/privacy-pools-website-v2/blob/c9583b030882645169e5ef1a127cb470fd228bab/services/passkey.ts) and [unlock policy](https://github.com/0xbow-io/privacy-pools-website-v2/blob/c9583b030882645169e5ef1a127cb470fd228bab/services/passkey-policy.ts).
- [Diagnostic redaction levels](https://github.com/0xbow-io/privacy-pools-website-v2/blob/c9583b030882645169e5ef1a127cb470fd228bab/services/debug-redaction.ts). The default No spending keys level retains a viewing key; No tx details is the strongest available level. A small synthetic-data smoke check verified removal of example spending/viewing secrets and transaction identifiers while retaining an error message. This was not a complete security audit of all possible diagnostics.
- [Google Chrome Help: use passkeys on another device](https://support.google.com/chrome/answer/13168025?hl=en) — documents the phone/another-device chooser and QR flow. The user's successful cancellation-and-phone sequence is case evidence, not a guarantee that every Chrome/macOS version presents the same screens.
