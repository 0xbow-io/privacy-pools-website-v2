// Stellar testnet moved to protocol 30 on 2026-11-06. Its ledger header (StellarValue ext variant 3) broke
// every base-reserve read in the vendored SDK, and with it every XLM deposit ("carries no readable header").
import { describe, expect, test } from 'bun:test';
import { xdr } from '@stellar/stellar-sdk';

import { STELLAR_TESTNET_NETWORK, STELLAR_TESTNET_RPC_URL } from '@/config/stellar-deployment';

/** Stellar testnet ledger 5595042's getLatestLedger `headerXdr` (protocol 30), captured from soroban-testnet.stellar.org. */
const P30_HEADER_XDR =
  'AAAAHhu3QIeMQD6i4XZqRwo0L/QgL94e1aPFj0Yr1ioSiIHgkxlNd5GShKIk06HVIckHKBAlkPs/kMAVFmjEzxyeYSEAAAAAau5AAwAAAAAAAAADAAABobKqDeQAAAAA1XJp2WJQ90ltB5vi6DUSNu//6NOcLga/q7FCHxf8ZxwAAABAilAk0dsbcUImYJYn2aJaYRVeCmiuEM1c+t/SsyV7idIoQ+ElJaEHdh4WJmshRWE3Dww74WOrGYWV5hHaj3iGChuwtXL3igXMCVtKl8czrj6HwMERgeqlDnYDoqxW1Xt0Jisns5prOgSxuOZbQYneLKOPftBJcF+Fk+ToFMSHR+4AVV+iDeC2s6dkAAAAACzRqt44kwAAAAAAAAAAAA50IQAAAGQATEtAAAAAyGqF+1l1eOuOzdzIu6O/Zgk0smF+0E4UZM9wQuibRa8Iw8x+P3Abpsy/T0ef+T+OUvJREiwSgRh8OcWe9S3I7xG81lbXEDPGdmLcmGu7HT05PgK5k4ZwAHfGHXPoGPzZJUTAaAz0AcKXg+0YuEt37ZCofX9OhI4/zMdPViWaDD1oAAAAAA==';

/** The vendored SDK's RPC interactor, its server answering getLatestLedger with `headerXdr`. */
async function interactorAnswering(headerXdr: unknown) {
  const sdk = await import('@privacy-pools-v2/stellar-sdk');
  const interactor = new sdk.SorobanRPCInteractor({ rpcUrl: STELLAR_TESTNET_RPC_URL, networkPassphrase: STELLAR_TESTNET_NETWORK.networkPassphrase });
  (interactor as unknown as { server: { getLatestLedger: () => Promise<unknown> } }).server.getLatestLedger = async () => ({ sequence: 5595042, headerXdr });
  return interactor;
}

describe('protocol 30 ledger header', () => {
  test('stellar-sdk decodes it (0.5 XLM base reserve)', () => {
    expect(BigInt(xdr.LedgerHeader.fromXDR(P30_HEADER_XDR, 'base64').baseReserve())).toBe(5_000_000n);
  });

  test('the vendored SDK reads the base reserve from the header getLatestLedger already decodes', async () => {
    const interactor = await interactorAnswering(xdr.LedgerHeader.fromXDR(P30_HEADER_XDR, 'base64'));
    expect(await interactor.getAccountCreationMinimum()).toBe(10_000_000n);
  });

  test('the vendored SDK still reads a raw base64 header', async () => {
    const interactor = await interactorAnswering(P30_HEADER_XDR);
    expect(await interactor.getAccountCreationMinimum()).toBe(10_000_000n);
  });

  test('an unreadable header is refused, not read as some reserve', async () => {
    const interactor = await interactorAnswering('not-a-header');
    await expect(interactor.getAccountCreationMinimum()).rejects.toThrow(/no readable header/);
  });
});
