// Run after build:web. Exercise the actual Metro output, not source imports:
// a Node-only crypto export can pass unit tests but fail field initialization
// in a browser. All keys and circuit inputs here are public test fixtures.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import ts from 'typescript';
import { MerkleService, PoseidonHashService } from '@privacy-pools-v2/sdk';
import { buildBabyjub, buildPoseidon } from 'circomlibjs';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dist = join(root, 'dist');
const scripts = join(dist, '_expo/static/js/web');
const files = readdirSync(scripts);
const sdkFile = files.find(name => /^sdk-runtime-.*\.js$/.test(name));
const commonFile = files.find(name => /^__common-.*\.js$/.test(name));
assert.ok(sdkFile && commonFile, 'Run build:web before testing the exported application');

// IDs and filenames change on every export. Locate the public exports in the
// built module table, then use the same Metro loader as the application.
function findModule(file, exports) {
  const source = ts.createSourceFile(file, readFileSync(join(scripts, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  for (const node of source.statements) {
    if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) continue;
    const [factory, id] = node.expression.arguments;
    if (factory && id && ts.isNumericLiteral(id) && exports.every(name => factory.getText(source).includes(name))) {
      return Number(id.text);
    }
  }
  throw new Error(`Cannot locate built exports: ${exports.join(', ')}`);
}
const sdkId = findModule(sdkFile, ['buildBabyjub', 'createPoolSession']);
const suiId = findModule(commonFile, ['Ed25519Keypair', 'fromSecretKey']);
const leaves = ['0x1', '0x2', '0x3'];
const hash = await PoseidonHashService.create();
const poseidon = await buildPoseidon();
const babyjub = await buildBabyjub();
const keypair = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(1));
const expected = {
  hash: hash.hash(['0x7']),
  root: await new MerkleService({ hashService: hash }).computeRoot(leaves),
  poseidon: String(poseidon.F.toObject(poseidon([7n]))),
  point: babyjub.mulPointEscalar(babyjub.Base8, 7n).map(value => String(babyjub.F.toObject(value))),
  signature: (await keypair.signPersonalMessage(new TextEncoder().encode('Public regression fixture'))).signature,
  valid: true,
  tampered: false,
  proofValid: true,
  proofTampered: false,
  workerVerified: true,
  secureRandom: true,
  publicSignals: ['2776268828143617767325899484059512255949727089272999342811188401532904180613', '2', '3', '4'],
};

const server = createServer((request, response) => {
  let file = dist + new URL(request.url, 'http://localhost').pathname;
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
  const type = file.endsWith('.js') ? 'application/javascript'
    : file.endsWith('.css') ? 'text/css'
      : file.endsWith('.html') ? 'text/html' : 'application/octet-stream';
  response.setHeader('Content-Type', type).end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByTestId('hub-shield-pay-token').waitFor();
  const actual = await page.evaluate(async ({ sdkFile, sdkId, suiId, leaves }) => {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `/_expo/static/js/web/${sdkFile}`;
      script.onload = resolve;
      script.onerror = reject;
      document.head.append(script);
    });
    const sdk = globalThis.__r(sdkId);
    const sui = globalThis.__r(suiId);
    const hash = await sdk.createHashService();
    const poseidon = await sdk.buildPoseidon();
    const babyjub = await sdk.buildBabyjub();
    const keypair = sui.Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(1));
    const message = new TextEncoder().encode('Public regression fixture');
    const { signature } = await keypair.signPersonalMessage(message);

    const inputs = {
      noteAddressHash: `0x${'1'.padStart(64, '0')}`,
      tokenId: '0x2', value: '0x3', context: '0x4',
      depositSecret: `0x${'5'.padStart(64, '0')}`,
    };
    const binary = async url => new Uint8Array(await (await fetch(url)).arrayBuffer());
    const [wasm, provingKey, verificationKey] = await Promise.all([
      binary('/artifacts/deposit/deposit_js/deposit.wasm'),
      binary('/artifacts/deposit/groth16_pkey.zkey'),
      fetch('/artifacts/deposit/groth16_vkey.json').then(response => response.json()),
    ]);
    const prover = sdk.createGroth16Prover();
    try {
      const { proof, publicSignals } = await prover.fullProve(inputs, wasm, provingKey);
      const altered = [...publicSignals];
      altered[3] = '5';
      return {
        hash: hash.hash(['0x7']),
        root: await sdk.createMerkleService(hash).computeRoot(leaves),
        poseidon: String(poseidon.F.toObject(poseidon([7n]))),
        point: babyjub.mulPointEscalar(babyjub.Base8, 7n).map(value => String(babyjub.F.toObject(value))),
        signature,
        valid: await keypair.getPublicKey().verifyPersonalMessage(message, signature),
        tampered: await keypair.getPublicKey().verifyPersonalMessage(new TextEncoder().encode('Tampered fixture'), signature),
        proofValid: await sdk.groth16.verify(verificationKey, publicSignals, proof),
        proofTampered: await sdk.groth16.verify(verificationKey, altered, proof),
        workerVerified: await prover.verify(verificationKey, publicSignals, proof),
        secureRandom: typeof globalThis.crypto?.getRandomValues === 'function',
        publicSignals,
      };
    } finally {
      prover.dispose();
    }
  }, { sdkFile, sdkId, suiId, leaves });
  assert.deepEqual(actual, expected);
  assert.deepEqual(errors, []);
  console.log('Production crypto passed: Poseidon, Merkle, BabyJubJub, Sui signatures, deposit proof and tamper rejection');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
