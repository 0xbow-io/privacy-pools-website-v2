# native-poseidon

circomlib's Poseidon over BN254 (1 to 16 inputs) in Rust, as a local Expo module.
On native, `metro-shims/circomlibjs-native.js` hands the SDK this instead of
circomlibjs's WASM Poseidon (Hermes has no WebAssembly). It checks 16 known
answers first and falls back to poseidon-lite if the module is missing or wrong.

- `rust/`: the crate. circomlibjs's optimized rounds over its own constants
  (`src/constants.bin`), arkworks' BN254 field. `cargo test` checks
  circomlibjs's outputs for every arity (`tests/vectors.json`) and
  light-poseidon for 1..12.
- `scripts/generate.ts`: writes `constants.bin` and `vectors.json` from
  circomlibjs. A bun test fails if the committed files drift.
- API (hex, 64 characters per element, concatenated): `hash(inputsHex)`,
  `hashBatch(arity, inputsHex)` (sync, JSI), `hashBatchAsync(arity, inputsHex)`.
  The JS poseidon also gets `hashBatch(list)` / `hashBatchAsync(list)`.

## Build

Android (`.so` and Kotlin bindings are committed):

```sh
cd modules/native-poseidon
cp -al "$ANDROID_HOME/ndk/27.1.12297006" rust/.ndk
safewrap env ANDROID_NDK_HOME="$PWD/rust/.ndk" bash android/build-jni.sh   # ABIS="arm64-v8a x86_64" for the emulator
```

iOS: macOS only. Run `ios/build-xcframework.sh`, or take the `native-poseidon-ios`
artifact from the `native-poseidon` workflow and put `native_poseidonFFI.xcframework`
and `native_poseidon.swift` in `ios/`. Without them the podspec builds a stub
and iOS uses poseidon-lite.

## Bench

- Rust: `cargo run --release --example bench` (also runs on a phone: build with
  `cargo ndk -t arm64-v8a build --release --example bench`, `adb push`, run).
- Host JS: `bun modules/native-poseidon/bench/bench-host.ts`.
- In the app: a dev build with `EXPO_PUBLIC_POSEIDON_BENCH=1` logs
  `[poseidon] native {...}` hashes/s for poseidon-lite, native single and batch.
