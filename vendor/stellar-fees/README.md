# Public Stellar fee helpers

Generated from the source map shipped in the pinned `@privacy-pools-v2/stellar-sdk`
package (0xbow v2-monorepo revision `1449fe37`, p30). Source contents, resource
calibrations, arithmetic, and the public configuration read are unchanged.
The generator replaces only the broad internal barrel with a fee-only barrel.
The SDK root eagerly imports proving and wallet code; background pricing must
not load those dependencies for every visitor. This module imports only the
existing Stellar library and zod. No new dependency or network service is added.

Regenerate after updating the pinned SDK:

```
bun scripts/stellar/build-fee-module.mjs
bun scripts/stellar/build-fee-module.mjs --check
```

Do not edit generated `index.js`. Tests compare this module's results and public
ledger keys against the installed SDK. Replace this extraction with a supported
SDK pricing subpath when one is available.

The application reads these public settings every minute on the shared feed grid
when Stellar is supported and opted into at page load (or debug is enabled). It
calculates all five transfer and withdrawal input counts locally. Missing settings
or settings at least two minutes old make the displayed estimate unavailable.
A failed refresh retains the last good settings within that freshness limit. The scheduler refreshes stale settings when an idle tab
becomes active. The SDK can retry a public RPC snapshot-gap error once.
The client uses the shared public RPC sender when anonymous RPC is active on
both dev and main; a routing failure propagates without a direct retry.

The native-XLM estimate adds 200,000 stroops flat fee and 100 stroops inclusion
to the resource fee with a 25% margin rounded up. This policy must be updated
alongside relayer configuration. The settings fixture was captured at testnet
ledger 5,681,871; at those settings all five shapes matched public unsigned
quotes (317289, 390145, 437862, 460439, 483015 stroops). This comparison does not
establish the deployed relayer image revision. Withdrawals price the costlier of the relay and registration
actions with n inputs and n outputs, then add the amount fee (50 basis points, rounded down)
and cap the total at 5,000,000 stroops. At the fixture settings, public unsigned
quotes for a 1 XLM withdrawal matched all five local estimates: 445273, 492989,
540703, 588420, and 636137 stroops.

Send, payment requests, and saving a claimed link share the transfer estimates.
As on EVM, transfer input selection reserves 25% over a fresh quote, falling back
to the unpadded fee when funds are tight. The binding quote must fit the selected
funds; the displayed estimate is not a fee ceiling. Unused funds return as change.
Withdraw shows a signed quote and expiry at Review, then refreshes it before
proving. Its shared EVM allowance (1%, with a 16-unit floor) permits small fee
changes; a larger increase returns the user to review. There is no fixed
application fee ceiling. PR81's single-proof transfer path remains shared by
registered sends, one-time links, payment requests, and claim saving.

These estimates do not repair an insufficient signed relayer quote. The observed
`RelayFeeBelowCost` response requires a separate relayer pricing fix; the client
preserves that error rather than reporting a wallet cancellation.
