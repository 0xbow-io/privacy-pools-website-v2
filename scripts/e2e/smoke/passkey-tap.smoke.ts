// @ts-nocheck - drives a real browser with real playwright types.
//
// A passkey prompt only ever follows a tap.
//
// A smart-contract wallet unlocks with a passkey. This runs one: the wallet's
// address answers eth_getCode with bytecode (wallet and app RPC alike), and a
// CDP virtual authenticator with PRF stands in for the device. Every
// navigator.credentials call is recorded with whether the page had a user
// activation when it was made.
//
//  1. Connect: the unlock dialog may open, but no WebAuthn call is made.
//  2. Tap "Create a passkey": exactly one create, its user handle <= 64 bytes.
//  3. Reload and open Withdraw without touching the dialog: no WebAuthn call.
//  4. Tap Sign in: exactly one get, for a credential whose user handle is
//     <= 64 bytes, and the dialog closes.
//
// Prod world, read-only wallet (./harness.ts): nothing is ever sent.
import { check, connect, finish, hubTab, launch, open, sleep } from './harness.ts';

// The guard reads this PR's surface, the unlock dialog: the hub behind it is
// guarded by the share-name smokes.
const s = await launch('passkey-tap', { smartWallet: true, guardScope: '[role="dialog"], [role="alert"], [role="status"]' });
const { page, context } = s;

await context.addInitScript(() => {
  const w = window as any;
  w.__webauthn = [];
  const create = navigator.credentials.create.bind(navigator.credentials);
  const get = navigator.credentials.get.bind(navigator.credentials);
  navigator.credentials.create = async (o: any) => {
    const rec: any = { kind: 'create', activation: navigator.userActivation?.isActive ?? null, userIdLen: o?.publicKey?.user?.id?.byteLength ?? null, prf: !!o?.publicKey?.extensions?.prf };
    w.__webauthn.push(rec);
    try { return await create(o); } catch (e: any) { rec.error = `${e?.name}: ${e?.message}`; throw e; }
  };
  navigator.credentials.get = async (o: any) => {
    const rec: any = { kind: 'get', activation: navigator.userActivation?.isActive ?? null, prf: !!o?.publicKey?.extensions?.prf };
    w.__webauthn.push(rec);
    try {
      const c: any = await get(o);
      rec.userHandleLen = c?.response?.userHandle?.byteLength ?? null;
      return c;
    } catch (e: any) { rec.error = `${e?.name}: ${e?.message}`; throw e; }
  };
});
const cdp = await context.newCDPSession(page);
await cdp.send('WebAuthn.enable');
const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true },
});
const calls = async () => page.evaluate(() => (window as any).__webauthn.splice(0)).catch(() => []);
const dialogOpen = () => page.getByText('Unlock with passkey').first().isVisible().catch(() => false);
const dialogSignIn = () => page.getByText(/^Sign in$/).last();
async function waitDialog(ms = 30_000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await dialogOpen()) return true;
    await sleep(500);
  }
  return false;
}
async function waitClosed(ms = 60_000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (!(await dialogOpen())) return true;
    await sleep(500);
  }
  return false;
}

try {
  // 1. Connect.
  await open(page, '/portfolio');
  check(await connect(page), 'the smart wallet connects');
  if (!(await waitDialog(20_000))) {
    // Not raised on connect: ask for it the way a user does.
    await page.getByTestId('portfolio-sign-in').first().click().catch(() => {});
  }
  check(await waitDialog(), 'the passkey unlock dialog opens for a smart-contract wallet');
  await sleep(3000);
  const onConnect = await calls();
  check(onConnect.length === 0, 'connect: no WebAuthn call before a tap', JSON.stringify(onConnect));
  await s.guardStep('passkey unlock dialog');

  // 2. Create a passkey (a tap).
  await page.getByTestId('seed-derivation-passkey-create').first().click();
  check(await waitClosed(), 'creating a passkey unlocks the account');
  const created = await calls();
  const creates = created.filter((c) => c.kind === 'create');
  check(creates.length === 1, 'the create tap makes exactly one create call', JSON.stringify(created));
  check(creates.every((c) => c.userIdLen != null && c.userIdLen <= 64), 'the passkey user handle is at most 64 bytes', JSON.stringify(creates.map((c) => c.userIdLen)));
  check(creates.every((c) => c.prf), 'the create call asks for PRF');
  const creds = (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials;
  const handles = creds.map((c) => (c.userHandle ? Buffer.from(c.userHandle, 'base64').length : null));
  check(creds.length === 1 && handles.every((n) => n != null && n <= 64), 'the stored credential has a user handle of at most 64 bytes', JSON.stringify(handles));

  // 3. Reload, open Withdraw, touch nothing in the dialog.
  await open(page, '/');
  await connect(page);
  await sleep(5000);
  if (await dialogOpen()) await page.getByLabel('Close account unlock').first().click().catch(() => {});
  await sleep(1500);
  const onLoad = await calls();
  check(onLoad.length === 0, 'reload: no WebAuthn call before a tap', JSON.stringify(onLoad));
  check(await hubTab(page, 'withdraw'), 'the Withdraw tab opens');
  await sleep(10_000);
  const onWithdraw = await calls();
  check(onWithdraw.length === 0, 'opening Withdraw starts no WebAuthn call', JSON.stringify(onWithdraw));
  check(await waitDialog(15_000), 'opening Withdraw asks for the tap instead (the unlock dialog)');
  await s.guardStep('withdraw with the passkey dialog');

  // 4. Sign in (a tap).
  await dialogSignIn().click();
  check(await waitClosed(), 'Sign in unlocks the account');
  await sleep(2000);
  const signedIn = await calls();
  check(signedIn.length === 1 && signedIn[0].kind === 'get', 'Sign in makes exactly one WebAuthn call, a get', JSON.stringify(signedIn));
  check(signedIn.every((c) => c.userHandleLen == null || c.userHandleLen <= 64), 'the signed-in user handle is at most 64 bytes', JSON.stringify(signedIn.map((c) => c.userHandleLen)));
  await s.guardStep('withdraw after passkey sign-in');
  await s.shot('withdraw');
  check(s.refusedSends.length === 0, 'nothing asked the wallet to send', s.refusedSends.join(', '));
} catch (e) {
  check(false, 'the smoke ran to the end', String(e).slice(0, 300));
}
await finish('passkey tap', s.browser);
