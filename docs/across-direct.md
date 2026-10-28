# Direct Across browser integration

Direct Across browser quoting is closed, including when `EXPO_PUBLIC_ACROSS_DIRECT=true`. `acrossWiring()` returns `privacy-transport-unavailable` when the SDK classes and configured source chains otherwise permit it. The app retains the existing LI.FI provider and its complete quote comparisons.

The SDK's direct quote API sends the destination MulticallHandler message, including the pool deposit proof and note data, to `suggested-fees`. Plain quotes and previews also disclose user action timing. A status lookup names a submitted transaction. These requests violate `privacy-request-discipline.md`; adding them to an allowlist does not make them acceptable.

`services/egress-policy.ts` explicitly refuses the Across party. No Across host, route, query field or header is approved. `fetchAcrossDirectEstimate()` is a cache-only interface with no transport and returns null. Direct Across status is never polled by the modal effects; it must eventually be resolved from bulk discovery. Existing LI.FI behavior is preserved, including with the flag off. This change does not claim to fix older LI.FI privacy debt.

Before enabling direct Across:

1. Provide and review a quote transport independent of UI action timing, without requests keyed on note data, recipient, user amount or relayed transaction hash. Merely proxying the same request is insufficient.
2. Add explicit egress declarations and tests for that transport's actual public requests. Keep note-bearing messages and per-transfer status refused.
3. Provide bulk destination confirmation and refund/failure handling, including the relayer dust-rescue integration.
4. Re-vendor the merged SDK, confirm on-chain SpokePool allowlisting through the separate operational process, and validate real execution in a separate authorized run.

The flags and pinned spender addresses are preparatory configuration. They do not establish production readiness. No share/underlying amount arithmetic or production settings changed in this review.
