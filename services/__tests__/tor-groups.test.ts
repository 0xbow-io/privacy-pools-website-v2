import { beforeEach, describe, expect, test } from 'bun:test';
import { keccak256 } from 'viem';
import { addTorAccount, beginTorOperation, currentTorOperation, noteTorQuotes, rpcSubject, setTorAccounts, torGroupFor } from '../tor-groups';

const SESSION = '0x00000000000000000000000000000000000000aA';
const WALLET = '0x1111111111111111111111111111111111111111';
const STELLAR = `G${'A'.repeat(55)}`;
const IMPORTED = '0x2222222222222222222222222222222222222222';
const HASH = `0x${'Ab'.repeat(32)}`;
const OTHER_HASH = `0x${'cd'.repeat(32)}`;
const RAW = '0x02f86c0180843b9aca00';
const padded = (address: string) => address.slice(2).toLowerCase().padStart(64, '0');
const key = (address: string) => `account:${address.slice(2).toLowerCase()}`;

beforeEach(() => {
  setTorAccounts([]);
  currentTorOperation() && beginTorOperation().end();
});

describe('anon-rpc isolation groups', () => {
  test('public requests share a group per party', () => {
    expect(torGroupFor('rpc', '{"method":"eth_blockNumber"}')).toBe('public:rpc');
    expect(torGroupFor('asp', 'https://asp.example/leaves')).toBe('public:asp');
    expect(torGroupFor('relayer', 'https://relayer.example/v1/details')).toBe('public:asp');
    expect(torGroupFor('lifi', 'https://li.quest/v1/tokens')).toBe('public:web');
    expect(torGroupFor('web', 'https://prices.example/')).toBe('public:web');
    expect(torGroupFor('sentry', 'https://sentry.example/')).toBe('public:sentry');
  });

  test('a request naming an account goes over that account\'s group, in hex case-insensitively', () => {
    setTorAccounts([SESSION, undefined, null, 'not-an-address', STELLAR]);
    const balanceOf = `{"method":"eth_call","params":[{"data":"0x70a08231${padded(SESSION)}"}]}`;
    expect(torGroupFor('rpc', balanceOf)).toBe(`account:${SESSION.slice(2).toLowerCase()}`);
    expect(torGroupFor('web', `{"addresses":["${SESSION.toUpperCase().replace('0X', '0x')}"]}`)).toBe(`account:${SESSION.slice(2).toLowerCase()}`);
    expect(torGroupFor('rpc', `https://horizon.example/accounts/${STELLAR}`)).toBe(`account:${STELLAR}`);
    expect(torGroupFor('rpc', `https://horizon.example/accounts/${STELLAR.toLowerCase()}`)).toBe('public:rpc');
  });

  test('a request naming two accounts goes over the session\'s, which was set first', () => {
    setTorAccounts([SESSION, WALLET]);
    expect(torGroupFor('rpc', `${WALLET} ${SESSION}`)).toBe(`account:${SESSION.slice(2).toLowerCase()}`);
  });

  test('a request about a transaction goes over that transaction\'s group, whoever sent it and whatever operation is open', () => {
    setTorAccounts([SESSION, WALLET]);
    const operation = beginTorOperation();
    expect(torGroupFor('rpc', '', { transaction: HASH })).toBe(`tx:${HASH.slice(2).toLowerCase()}`);
    expect(torGroupFor('lifi', `https://li.quest/v1/status?txHash=${HASH}`, { transaction: HASH, identifying: true }))
      .toBe(`tx:${HASH.slice(2).toLowerCase()}`);
    expect(torGroupFor('rpc', '', { transaction: 'DigestInBase58' })).toBe('tx:DigestInBase58');
    operation.end();
  });

  test('a request a known or unknown account signs goes over that account\'s group', () => {
    expect(torGroupFor('rpc', 'AAAA', { account: WALLET })).toBe(key(WALLET));
    expect(torGroupFor('rpc', 'AAAA', { account: STELLAR, transaction: HASH })).toBe(`account:${STELLAR}`);
  });

  test('accounts set before stay known, and an added account is known before the providers list it', () => {
    setTorAccounts([SESSION]);
    setTorAccounts([WALLET]);
    expect(torGroupFor('rpc', `{"data":"${padded(SESSION)}"}`)).toBe(key(SESSION));
    addTorAccount(IMPORTED);
    expect(torGroupFor('rpc', `{"params":["${IMPORTED}"]}`)).toBe(key(IMPORTED));
  });

  test('rpcSubject names the transaction an EVM body sends or looks up, and identifies a batch about two', () => {
    expect(rpcSubject(`{"method":"eth_getTransactionReceipt","params":["${HASH}"]}`)).toEqual({ transaction: HASH.slice(2).toLowerCase() });
    expect(rpcSubject(`[{"method":"eth_blockNumber"},{"method":"eth_getTransactionByHash","params":["${HASH}"]}]`))
      .toEqual({ transaction: HASH.slice(2).toLowerCase() });
    expect(rpcSubject(`{"method":"eth_sendRawTransaction","params":["${RAW}"]}`)).toEqual({ transaction: keccak256(RAW).slice(2) });
    expect(rpcSubject(`[{"method":"eth_getTransactionReceipt","params":["${HASH}"]},{"method":"eth_getTransactionReceipt","params":["${OTHER_HASH}"]}]`))
      .toEqual({ identifying: true });
    expect(rpcSubject('{"method":"eth_call","params":[{}]}')).toEqual({});
    expect(rpcSubject('not json')).toEqual({});
    expect(rpcSubject(null)).toEqual({});
  });

  test('an operation\'s relayer and LI.FI requests share its group until it ends; chain reads stay public', () => {
    const first = beginTorOperation();
    expect(currentTorOperation()).toBe(first.key);
    expect(torGroupFor('relayer', 'https://relayer.example/v1/quote')).toBe(first.key);
    expect(torGroupFor('lifi', 'https://li.quest/v1/quote')).toBe(first.key);
    expect(torGroupFor('asp', 'https://asp.example/leaves')).toBe('public:asp');
    expect(torGroupFor('rpc', '{"method":"eth_getLogs"}')).toBe('public:rpc');
    first.end();
    expect(torGroupFor('relayer', 'https://relayer.example/v1/details')).toBe('public:asp');
    const second = beginTorOperation();
    expect(second.key).not.toBe(first.key);
    first.end(); // a stale end leaves the newer operation in place
    expect(currentTorOperation()).toBe(second.key);
    second.end();
    expect(currentTorOperation()).toBeNull();
  });

  test('a request an operation sent, repeated after it ends, gets a group of its own rather than the next operation\'s', () => {
    const quote = 'https://li.quest/v1/quote/contractCalls\n{"toAddress":"0xrecipient"}';
    const first = beginTorOperation();
    expect(torGroupFor('lifi', quote)).toBe(first.key);
    expect(torGroupFor('lifi', quote)).toBe(first.key);
    first.end();
    expect(torGroupFor('lifi', quote)).toMatch(/^subject:/);
    // However late the retry: a slow first attempt may take minutes to fail.
    const now = Date.now;
    Date.now = () => now() + 3_600_000;
    try {
      const second = beginTorOperation();
      expect(torGroupFor('lifi', quote)).toMatch(/^subject:/);
      second.end();
    } finally {
      Date.now = now;
    }
    const second = beginTorOperation();
    expect(torGroupFor('lifi', quote)).toMatch(/^subject:/);
    expect(torGroupFor('lifi', 'https://li.quest/v1/quote?fromChain=10')).toBe(second.key);
    second.end();
  });

  test('an identifying request rides the operation, or outside one gets a group of its own', () => {
    const a = torGroupFor('asp', 'https://asp.example/labels/1', { identifying: true });
    const b = torGroupFor('asp', 'https://asp.example/labels/2', { identifying: true });
    expect(a).toMatch(/^subject:/);
    expect(b).toMatch(/^subject:/);
    expect(a).not.toBe(b);
    const operation = beginTorOperation();
    expect(torGroupFor('asp', 'https://asp.example/labels/3', { identifying: true })).toBe(operation.key);
    operation.end();
  });
  test('a relay goes with the operation that fetched its quote while it lasts, and after it ends never with public traffic or another operation', () => {
    const commitment = `0x${'7a'.repeat(65)}`;
    const relay = `https://relayer.example/v1/relay\n{"signedFeeCommitment":{"signedRelayerCommitment":"${commitment.toUpperCase().replace('0X', '0x')}"}}`;
    const first = beginTorOperation();
    noteTorQuotes(first.key, `{"feeCommitment":{"signedRelayerCommitment":"${commitment}"}}`);
    expect(torGroupFor('relayer', relay)).toBe(first.key);
    const second = beginTorOperation();
    expect(torGroupFor('relayer', relay)).toBe(first.key);
    first.end();
    const late = torGroupFor('relayer', relay);
    expect(late).toMatch(/^subject:/);
    expect(late).not.toBe(second.key);
    second.end();
    expect(torGroupFor('relayer', relay)).toMatch(/^subject:/);
  });

  test('a Sui relay goes with the operation that fetched its quote, by the fee commitment signature', () => {
    const feeCommitment = { asset: '0x2::sui::SUI', feeAmount: '10', expiresAt: 1, relayer: '0x9', signature: 'AQIDBA+/sig==' };
    const first = beginTorOperation();
    noteTorQuotes(first.key, JSON.stringify({ feeAmount: '10', feeCommitment }));
    const second = beginTorOperation();
    const relay = `https://relayer.example/v1/relay/withdrawal\n${JSON.stringify({ proof: '0x01', feeCommitment })}`;
    expect(torGroupFor('relayer', relay)).toBe(first.key);
    first.end();
    second.end();
  });

  test('a relayer quote or relay outside an operation never goes over the public group', () => {
    expect(torGroupFor('relayer', 'https://relayer.example/v1/quote/evm/1/transfer\n{"amount":"1"}')).toMatch(/^subject:/);
    expect(torGroupFor('lifi', 'https://li.quest/v1/quote/contractCalls\n{"fromAmount":"1"}')).toMatch(/^subject:/);
    expect(torGroupFor('relayer', 'https://relayer.example/v1/details\n')).toBe('public:asp');
  });
});
