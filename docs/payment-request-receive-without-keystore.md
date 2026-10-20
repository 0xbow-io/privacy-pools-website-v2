What I did is use the discovery data embedded in the payment request instead of looking up the seller's viewing key in the keystore, because the seller may not be registered yet.

The request/link carries the payment public key, tag, note secrets map, amount, and token. The payer passes that into `prepareFulfillPaymentRequest`, which calls `prepareTransfer` with explicit recipient discovery data.

So receiving works without seller keystore registration. But withdrawing/spending still requires registration, because the spend proof needs the seller's auth/nullifying key in the keystore.
