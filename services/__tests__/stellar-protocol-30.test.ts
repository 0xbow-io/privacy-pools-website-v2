// Stellar testnet moved to protocol 30 on 2026-11-06. Its ledger header (StellarValue ext variant 3) broke
// every base-reserve read in the vendored SDK, and with it every XLM deposit ("carries no readable header").
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { rpc, xdr } from '@stellar/stellar-sdk';

import { STELLAR_TESTNET_NETWORK, STELLAR_TESTNET_RPC_URL } from '@/config/stellar-deployment';

/** Stellar testnet ledger 5595042's getLatestLedger `headerXdr` (protocol 30), captured from soroban-testnet.stellar.org. */
const P30_HEADER_XDR =
  'AAAAHhu3QIeMQD6i4XZqRwo0L/QgL94e1aPFj0Yr1ioSiIHgkxlNd5GShKIk06HVIckHKBAlkPs/kMAVFmjEzxyeYSEAAAAAau5AAwAAAAAAAAADAAABobKqDeQAAAAA1XJp2WJQ90ltB5vi6DUSNu//6NOcLga/q7FCHxf8ZxwAAABAilAk0dsbcUImYJYn2aJaYRVeCmiuEM1c+t/SsyV7idIoQ+ElJaEHdh4WJmshRWE3Dww74WOrGYWV5hHaj3iGChuwtXL3igXMCVtKl8czrj6HwMERgeqlDnYDoqxW1Xt0Jisns5prOgSxuOZbQYneLKOPftBJcF+Fk+ToFMSHR+4AVV+iDeC2s6dkAAAAACzRqt44kwAAAAAAAAAAAA50IQAAAGQATEtAAAAAyGqF+1l1eOuOzdzIu6O/Zgk0smF+0E4UZM9wQuibRa8Iw8x+P3Abpsy/T0ef+T+OUvJREiwSgRh8OcWe9S3I7xG81lbXEDPGdmLcmGu7HT05PgK5k4ZwAHfGHXPoGPzZJUTAaAz0AcKXg+0YuEt37ZCofX9OhI4/zMdPViWaDD1oAAAAAA==';

async function interactor() {
  const sdk = await import('@privacy-pools-v2/stellar-sdk');
  return new sdk.SorobanRPCInteractor({ rpcUrl: STELLAR_TESTNET_RPC_URL, networkPassphrase: STELLAR_TESTNET_NETWORK.networkPassphrase });
}

describe('protocol 30 ledger header', () => {
  afterEach(() => {
    spyOn(rpc.Server.prototype, 'getLatestLedger').mockRestore();
  });

  test('stellar-sdk decodes it (0.5 XLM base reserve)', () => {
    expect(BigInt(xdr.LedgerHeader.fromXDR(P30_HEADER_XDR, 'base64').baseReserve())).toBe(5_000_000n);
  });

  test('the vendored SDK reads the base reserve from the header getLatestLedger already decodes', async () => {
    spyOn(rpc.Server.prototype, 'getLatestLedger').mockResolvedValue({
      sequence: 5595042,
      headerXdr: xdr.LedgerHeader.fromXDR(P30_HEADER_XDR, 'base64'),
    } as unknown as rpc.Api.GetLatestLedgerResponse);
    expect(await (await interactor()).getAccountCreationMinimum()).toBe(10_000_000n);
  });

  test('the vendored SDK still reads a raw base64 header', async () => {
    spyOn(rpc.Server.prototype, 'getLatestLedger').mockResolvedValue({
      sequence: 5595042,
      headerXdr: P30_HEADER_XDR,
    } as unknown as rpc.Api.GetLatestLedgerResponse);
    expect(await (await interactor()).getAccountCreationMinimum()).toBe(10_000_000n);
  });
});
