import { describe, expect, test } from 'bun:test';
import { StellarRegistrationCancelledError, StellarRegistrationPrompts, type StellarRegistrationPrompt } from '../stellar/stellar-registration-prompt';
import { registerStellarAccount } from '../stellar/stellar-registration';
import type { StellarPoolSession } from '../stellar/stellar-account';

type Registration = Awaited<ReturnType<StellarPoolSession['prepareRegisterKeystore']>>;
const missing = (auth = true, viewing = true) => ({
  alreadyRegistered: !auth && !viewing,
  keystoreCalldata: auth ? {} : null,
  viewingKeyCalldata: viewing ? {} : null,
}) as Registration;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

// Stub only the SDK boundary. Consent, retries, confirmation and cancellation
// run through the production code. Prompt events synchronize tests without sleeps.
function harness(initial = missing()) {
  const prompts = new StellarRegistrationPrompts();
  let nextPrompt = deferred<StellarRegistrationPrompt>();
  const control = { active: true, owner: 'owner', state: initial, rejectViewing: false, confirm: true, submitted: null as ReturnType<typeof deferred<void>> | null };
  const sent: { auth: boolean; viewing: boolean }[] = [];
  const statuses: string[] = [];
  const entered = deferred<void>();
  const detach = prompts.attach((prompt) => {
    if (prompt && !prompt.pending) {
      const event = nextPrompt;
      nextPrompt = deferred<StellarRegistrationPrompt>();
      event.resolve(prompt);
    }
  }, (address) => address === control.owner);
  const run = () => registerStellarAccount({
    session: { prepareRegisterKeystore: async () => control.state },
    address: 'owner',
    assertActive: () => { if (!control.active) throw new Error('Superseded'); },
    requestConsent: (prompt) => prompts.request(prompt, () => control.active),
    onStatus: (status) => statuses.push(status),
    execute: async (prepared) => {
      sent.push({ auth: !!prepared.keystoreCalldata, viewing: !!prepared.viewingKeyCalldata });
      entered.resolve();
      if (control.submitted) await control.submitted.promise;
      if (control.rejectViewing) {
        control.state = missing(false, true);
        throw new Error('Second signature rejected');
      }
      if (control.confirm) control.state = missing(false, false);
    },
    wait: async () => {},
  }).finally(prompts.finish);
  return { prompts, control, sent, statuses, detach, run, entered: entered.promise, nextPrompt: () => nextPrompt.promise };
}

async function start(h: ReturnType<typeof harness>) {
  const opened = h.nextPrompt();
  const done = h.run();
  await opened;
  return { done };
}

describe('Stellar registration', () => {
  test('consent gates submission and repeated approval cannot submit twice', async () => {
    const h = harness();
    const { done } = await start(h);
    expect(h.sent).toEqual([]);
    h.prompts.approve();
    h.prompts.approve();
    await done;
    expect(h.sent).toEqual([{ auth: true, viewing: true }]);
    expect(h.statuses.at(-1)).toBe('compatible');
  });

  test('dismissing consent settles the request and a later request can proceed', async () => {
    const h = harness();
    const first = await start(h);
    h.prompts.cancel();
    await expect(first.done).rejects.toBeInstanceOf(StellarRegistrationCancelledError);
    expect(h.sent).toEqual([]);
    const next = await start(h);
    h.prompts.approve();
    await next.done;
    expect(h.sent).toHaveLength(1);
  });

  test('detaching the modal host settles pending consent without a submission', async () => {
    const h = harness();
    const { done } = await start(h);
    h.detach();
    await expect(done).rejects.toBeInstanceOf(StellarRegistrationCancelledError);
    expect(h.sent).toEqual([]);
  });

  for (const change of ['owner', 'caller']) {
    test(`${change} changing while consent is open prevents submission`, async () => {
      const h = harness();
      const { done } = await start(h);
      if (change === 'owner') h.control.owner = 'another-owner';
      else h.control.active = false;
      h.prompts.approve();
      await expect(done).rejects.toBeInstanceOf(StellarRegistrationCancelledError);
      expect(h.sent).toEqual([]);
    });
  }

  test('a completed first step is not replayed after the second signature is rejected', async () => {
    const h = harness();
    h.control.rejectViewing = true;
    const { done } = await start(h);
    const failed = h.nextPrompt();
    h.prompts.approve();
    expect(await failed).toMatchObject({ finish: true, error: 'Second signature rejected' });
    expect(h.statuses.at(-1)).toBe('partial');
    expect(h.sent).toEqual([{ auth: true, viewing: true }]);
    // Retry requires another approval, and receives only the missing leg.
    h.control.rejectViewing = false;
    h.prompts.approve();
    await done;
    expect(h.sent).toEqual([{ auth: true, viewing: true }, { auth: false, viewing: true }]);
    expect(h.statuses.at(-1)).toBe('compatible');
  });

  test('setup completed elsewhere while consent is open needs no submission', async () => {
    const h = harness();
    const { done } = await start(h);
    h.control.state = missing(false, false);
    h.prompts.approve();
    await done;
    expect(h.sent).toEqual([]);
    expect(h.statuses.at(-1)).toBe('compatible');
  });

  test('unconfirmed setup offers an error instead of completing or resubmitting automatically', async () => {
    const h = harness();
    h.control.confirm = false;
    const { done } = await start(h);
    const failed = h.nextPrompt();
    h.prompts.approve();
    expect((await failed).error).toContain('has not shown up');
    expect(h.statuses).not.toContain('compatible');
    expect(h.sent).toHaveLength(1);
    h.prompts.cancel();
    await expect(done).rejects.toBeInstanceOf(StellarRegistrationCancelledError);
  });

  test('already complete setup finishes without waiting for consent or submitting', async () => {
    const h = harness(missing(false, false));
    await h.run();
    expect(h.sent).toEqual([]);
    expect(h.statuses.at(-1)).toBe('compatible');
  });

  for (const change of ['dismissal', 'caller']) {
    test(`${change} during submission cannot resume the original action`, async () => {
      const h = harness();
      const submitted = deferred<void>();
      h.control.submitted = submitted;
      const { done } = await start(h);
      h.prompts.approve();
      await h.entered;
      if (change === 'dismissal') h.prompts.cancel();
      else h.control.active = false;
      submitted.resolve();
      await expect(done).rejects.toThrow();
      expect(h.statuses).not.toContain('compatible');
    });
  }

  test('consent cannot be reused after its host is replaced, even for the same owner', async () => {
    const h = harness();
    const { done } = await start(h);
    h.prompts.approve();
    h.detach();
    h.prompts.attach(() => {}, () => true);
    await expect(done).rejects.toBeInstanceOf(StellarRegistrationCancelledError);
    expect(h.sent).toEqual([]);
  });

  test('a registration without a mounted dialog fails instead of signing or hanging', async () => {
    const h = harness();
    h.detach();
    await expect(h.run()).rejects.toBeInstanceOf(StellarRegistrationCancelledError);
    expect(h.sent).toEqual([]);
  });
});
