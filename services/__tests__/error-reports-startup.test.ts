import { expect, mock, test } from 'bun:test';
import type { IncomingEvent, OutgoingEvent } from '../error-reports-event';

test('reports queued during client loading retain privacy filtering and initialize once', async () => {
  let beforeSend: (event: IncomingEvent) => OutgoingEvent | null;
  let initializations = 0;
  const sent: (OutgoingEvent | null)[] = [];
  const delivered = Promise.withResolvers<void>();
  mock.module('@sentry/react', () => ({
    init: (options: { beforeSend: typeof beforeSend }) => {
      initializations++;
      beforeSend = options.beforeSend;
    },
    captureEvent: (event: IncomingEvent) => {
      sent.push(beforeSend(event));
      if (sent.length === 2) delivered.resolve();
    },
  }));
  const { initSentry, sendErrorReportEvent } = await import('../error-reports-sentry.web');
  sendErrorReportEvent({ message: 'deposit-failed' }); // Disabled before initialization.
  initSentry('https://public@example.com/1', { environment: 'staging' });
  initSentry('https://public@example.com/1', { environment: 'staging' });
  sendErrorReportEvent({
    message: 'egress-refused', egressParty: 'asp', egressReason: 'undeclared ASP route',
    walletAddress: 'private-wallet-address',
  });
  sendErrorReportEvent({ message: 'withdraw-failed', hasAmount: true, amount: 'private-amount' });
  await delivered.promise;
  expect(initializations).toBe(1);
  expect(sent).toHaveLength(2);
  expect(sent[0]).toMatchObject({
    environment: 'staging', level: 'warning',
    contexts: { egress: { party: 'asp', reason: 'undeclared ASP route' } },
  });
  expect(sent[1]?.contexts?.flags).toEqual({ hasAmount: true });
  expect(JSON.stringify(sent)).not.toContain('private-wallet-address');
  expect(JSON.stringify(sent)).not.toContain('private-amount');
});
