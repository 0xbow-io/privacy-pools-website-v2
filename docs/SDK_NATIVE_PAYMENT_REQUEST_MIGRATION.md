# SDK-Native Payment Request Migration

## Goal

Replace the website's hand-rolled payment request v2 flow with the SDK-native payment request flow from `@privacy-pools-v2/sdk`.

The current website creates a custom request payload with `recipientViewingPubKey`, but the payer path still calls `prepareTransfer` with:

```ts
recipientDiscoveryData: { evmAddress: request.recipientAddress }
```

That is the wrong branch for unregistered recipients. If the seller is not registered in the keystore, the SDK downgrades to out-of-band semantics and no recipient `Note` event is emitted.

The SDK-native flow already solves this:

1. Seller calls `poolSession.generatePaymentRequest({ amount, tokenId, slots })`.
2. Website serializes the public `PaymentRequest` into the `/pay/<encoded>` link.
3. Payer opens the link and calls `poolSession.prepareFulfillPaymentRequest({ paymentRequest, inputCommitments, ... })`.
4. Payer submits with `poolSession.relayTransfer(result.relayOptions[0])`.
5. Seller later calls `discoverNotes()`, which scans open payment requests by tag and decrypts with the persisted `paymentPrivKey`.

## SDK Source Of Truth

Current SDK source lives in:

```txt
/home/pe/newnewrepos/w/0xbow/v2-monorepo/packages/sdk/src
```

Relevant paths:

- `services/poolSessions/PoolSessionTransfer.ts`
- `services/PaymentRequestService.ts`
- `services/NoteDiscoveryService.ts`
- `services/poolSessions/PoolSessionNoteDiscovery.ts`
- `types/PaymentRequest.ts`

Important SDK behavior:

- `generatePaymentRequest()` returns the public shareable request fields:
  - `paymentId`
  - `noteSecretsMap`
  - `amount`
  - `tokenId`
  - `tag`
  - `paymentPubKey`
- The full private request record is persisted inside the SDK `PaymentRequestService`, including:
  - `paymentPrivKey`
  - `recipientAddress`
  - `status`
  - `fulfilledByCommitments`
- `prepareFulfillPaymentRequest()` internally calls `prepareTransfer()` with:

```ts
recipientDiscoveryData: {
  publicViewingKey: paymentRequest.paymentPubKey,
  noteSecretsMap: paymentRequest.noteSecretsMap,
  hint: paymentRequest.tag,
}
```

That is the key difference. It does not depend on keystore registration.

## Website Files To Change

Primary files:

- `components/payment-request-modal-provider.tsx`
- `services/payment-requests.ts`
- `app/pay/[encoded].tsx`

Likely support files:

- `services/pool-session-service.ts`
- `services/sdk-types.ts`
- `components/sdk-provider.tsx`
- account/note backup code if payment request storage must be exported

## Current Website Flow To Remove Or Deprecate

The website currently defines custom request shapes in `services/payment-requests.ts`:

- `PaymentRequestPayloadV1`
- `PaymentRequestPayloadV2`
- local `StoredPaymentRequest`

The v2 custom format is not the SDK-native `PaymentRequest`.

The main incorrect path is in `components/payment-request-modal-provider.tsx` inside the pay handler:

```ts
const result = request.version === 2
  ? await session.prepareTransfer({
      ...sharedParams,
      recipientDiscoveryData: { evmAddress: request.recipientAddress },
    })
  : await session.prepareTransfer({
      ...sharedParams,
      recipientNoteAddressHash: [request.noteAddressHash],
    });
```

Replace the v2 branch with SDK-native `prepareFulfillPaymentRequest()`.

## Implementation Plan

1. Update request serialization to support SDK `PaymentRequest`.

Represent `noteSecretsMap` as JSON-safe entries in links:

```ts
type SerializedSdkPaymentRequest = {
  kind: 'ppv2-sdk-payment-request';
  version: 1;
  paymentId: Hex;
  noteSecretsMap: [Hex, Hex][];
  amount: Hex;
  tokenId: Hex;
  tag: Hex;
  paymentPubKey: Hex;
};
```

At parse time:

```ts
const paymentRequest = {
  ...payload,
  noteSecretsMap: new Map(payload.noteSecretsMap),
};
```

Keep legacy custom v1/v2 parsers for backward compatibility with links already generated in the wild, but generate only SDK-native links going forward.

2. Change `Ask for Payment`.

Instead of manually deriving `recipientViewingPubKey` or local `noteSecret`, call:

```ts
const paymentRequest = await poolSession.generatePaymentRequest({
  amount,
  tokenId: selectedToken.address,
  slots: 5,
});
```

Then serialize the public `paymentRequest` into `/pay/<encoded>`.

Important: this requires the SDK payment request storage adapter to persist the private record. That should already happen if the `PoolSession` is built with persistent storage support. Verify in the actual app session construction.

3. Change `Pay Request`.

For SDK-native request payloads, call:

```ts
const prepared = await session.prepareFulfillPaymentRequest({
  paymentRequest,
  inputCommitments,
  relayAddress,
  feeAmount,
  processorAddress,
});

const result = await session.relayTransfer(prepared.relayOptions[0]);
```

Do not call `prepareTransfer({ recipientDiscoveryData: { evmAddress } })` for SDK-native payment requests.

4. Change success UI.

For SDK-native payment requests:

- do not generate a receive/import receipt link
- show a normal sent state
- tell the recipient side to sync/discover notes

The recipient should not need pasted JSON or a receipt URL for SDK-native payment requests.

5. Change receive flow.

Keep receive/import only for legacy v1 out-of-band receipts.

For SDK-native payment requests, the receive flow is:

```ts
await poolSession.discoverNotes();
```

Discovery will:

- fetch `Note` events
- load open SDK payment requests from the SDK payment request store
- run `scanPaymentRequests(events, openRequests)`
- mark matching requests fulfilled

6. Ensure payment request private records survive refresh.

The seller must keep the SDK's persisted `PaymentRequestRecord`, especially `paymentPrivKey`.

Check that `PoolSessionFactory.create(...)` is getting a persistent storage adapter in the website. If not, wire one through session creation.

This is load-bearing. If the seller creates a payment request and loses the private request record before syncing, they cannot decrypt the matching event later.

7. Add backup/export coverage.

The website already has note backup/export. It should either:

- include SDK payment request storage state in the backup, or
- add a separate "Export Payment Requests" backup path, or
- make clear that open payment requests are device-local until fulfilled.

Preferred: include payment request store in the same backup flow.

## Compatibility Strategy

Keep these for old links:

- custom v1 payment request
- custom v1 receipt/import
- custom v2 links if any were already generated

But new request links should be SDK-native only.

Runtime branching:

```ts
if (payload.kind === 'ppv2-sdk-payment-request') {
  // SDK-native: prepareFulfillPaymentRequest + relayTransfer
} else if (payload.version === 2) {
  // legacy custom v2: either convert if possible or show unsupported/migration copy
} else {
  // legacy v1: existing receipt/import flow
}
```

## Key Product Semantics

This works without seller keystore registration because the seller first generates a payment request link containing the SDK public discovery material.

It does not mean a payer can privately transfer to an arbitrary unregistered raw EVM address and have the recipient discover it later. Raw-address transfer still falls back to out-of-band when the keystore has no viewing key.

## Tests / Manual Verification

Test path:

1. Seller wallet creates request link.
2. Reload seller browser.
3. Payer wallet opens `/pay/<encoded>`.
4. Payer pays via relayer.
5. Seller reconnects same wallet and runs sync/discover.
6. Seller sees received note without receipt import.

Also test:

- seller not registered in keystore
- seller registered in keystore
- legacy v1 receive link still imports
- old custom v2 link handling does not silently lose funds

