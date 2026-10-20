#!/usr/bin/env bun
// Writes the two files the Rust crate is built and tested from, both taken
// from circomlibjs itself so nothing is restated by hand:
//
//   rust/src/constants.bin  circomlibjs's optimized Poseidon constants
//                           (poseidon_constants_opt.json: C, S, M, P for
//                           t = 2..17), each element 32 bytes little-endian.
//   rust/tests/vectors.json inputs and circomlibjs's WASM Poseidon output for
//                           every arity 1..16.
//
// Run from the repo root: bun modules/native-poseidon/scripts/generate.ts
// services/__tests__/native-poseidon-module.test.ts regenerates both in memory
// and fails if the committed files differ.
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConstants, buildVectors } from './poseidon-data';

const crate = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'rust');
// Build both before writing either, so a failure leaves the committed pair as it was.
const bin = buildConstants();
const vectors = await buildVectors();
writeFileSync(resolve(crate, 'src', 'constants.bin'), bin);
writeFileSync(resolve(crate, 'tests', 'vectors.json'), `${JSON.stringify(vectors, null, 1)}\n`);
console.log(`constants.bin: ${bin.length} bytes, vectors.json: ${vectors.length} vectors`);
