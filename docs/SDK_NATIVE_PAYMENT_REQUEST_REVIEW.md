# SDK-Native Payment Request Review

Scope: reviewed the current working-tree changes for payment-request backup/restore, unsupported-chain handling, SDK storage serialization, and debug redaction. No implementation changes were applied.

## Findings

### P1 — Importing a backup can overwrite newer local open payment requests

`parseAccountBackup()` restores `envelope.paymentRequests` through `restorePaymentRequestStateForChain()` at `services/wallet-backup-encryption.ts:215` and `services/wallet-backup-encryption.ts:248`. That helper calls `PaymentRequestStorageAdapter.saveState()` directly at `services/wallet-backup-encryption.ts:132`, replacing the whole SDK payment-request state for the chain.

Impact: if a seller creates new request links after taking an older backup, then imports that older backup later, the import can delete the newer local `paymentPrivKey`s. Those newer links may still be paid, but the seller will no longer be able to discover those payments.

Fix direction: merge imported payment-request records with the current local state by `paymentId` instead of replacing the whole state. Preserve local records on conflicts unless the imported record is strictly newer or the user explicitly chooses overwrite.

### P1 — Backup restore saves unvalidated SDK payment-request state

`restorePaymentRequestStateForChain()` only checks `Array.isArray(state.requests)` at `services/wallet-backup-encryption.ts:131`, then saves the state at `services/wallet-backup-encryption.ts:132`. `PaymentRequestStorageAdapter.saveState()` is a raw write path; validation happens on `getState()`/`loadFromStorage()`, not on save.

Impact: a malformed or hand-edited plain backup can write invalid payment-request state into local storage. The next PoolSession initialization may treat it as corrupt and clear it, potentially dropping otherwise valid local request state.

Fix direction: validate imported payment-request state with the SDK schema before saving, or write then immediately read back through the adapter and abort/restore the previous state if validation fails. Merging with current state should also validate the final merged state.

### P2 — Encrypted backup metadata is ignored during import

`PasswordEncryptedPayload` carries `walletAddress` and `chainId` at `services/wallet-backup-encryption.ts:12`, but `parseAccountBackup()` ignores the address parameter (`_address`) at `services/wallet-backup-encryption.ts:190` and restores encrypted payment-request state under the current session chain at `services/wallet-backup-encryption.ts:248`, regardless of the backup's embedded `chainId`.

Impact: importing the wrong wallet or chain backup can silently place payment-request state under the active chain. That can lead to confusing "restored" requests that cannot discover anything useful, or can overwrite valid state if combined with the replacement behavior above.

Fix direction: validate `parsed.walletAddress` and `parsed.chainId` against the active wallet/chain for encrypted backups. For plain backups, consider adding chain/address metadata to the envelope and validating when present.

### P2 — Backup creation silently omits corrupt payment-request state

`loadPaymentRequestStateForChain()` catches all errors and returns `null` at `services/wallet-backup-encryption.ts:118`. `prepareAccountBackup()` then creates a successful backup at `services/wallet-backup-encryption.ts:171` without warning that open payment-request recovery data was skipped.

Impact: a user can receive "backup ready" while the backup excludes the payment-request private keys needed to recover open links. This is especially risky because the exported notes may look complete.

Fix direction: surface a warning in `PreparedAccountBackup.warning` when payment-request state cannot be loaded, and show it in the export modal before the user relies on the backup.

## Verification

`bunx tsc --noEmit` passes.

`git diff --check` passes.

Resolved since the last review: payment-request state is now included in note backups, unsupported request chain IDs are rejected before wallet/RPC calls, and sensitive payment logs are no longer retained unless debug mode is enabled.

## Notes

The implementation now covers the key recovery gap, but import semantics need to be safer. The highest-risk issue is replacement of local open payment requests during restore; that can orphan request links created after the imported backup was taken.
