#!/usr/bin/env bash
# Builds the Rust core for Android and regenerates UniFFI's Kotlin bindings.
# Output (committed, so an app build needs no Rust toolchain):
#   android/src/main/jniLibs/<abi>/libnative_poseidon.so
#   android/src/main/java/uniffi/native_poseidon/native_poseidon.kt
# Needs cargo-ndk and an NDK (ANDROID_NDK_HOME, or the newest under $ANDROID_HOME/ndk).
# ABIS defaults to arm64-v8a (devices); add x86_64 for the emulator. An ABI
# without the library falls back to poseidon-lite in JS, it does not crash.
#
# Under safewrap (env cleared, cwd only), from modules/native-poseidon:
#   cp -al "$ANDROID_HOME/ndk/<version>" rust/.ndk
#   safewrap env ANDROID_NDK_HOME="$PWD/rust/.ndk" bash android/build-jni.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
crate="$here/../rust"
cd "$crate"

abis="${ABIS:-arm64-v8a}"
# nproc on Linux, sysctl on macOS.
cpus="$(nproc 2>/dev/null || sysctl -n hw.ncpu)"
jobs="${JOBS:-$(( cpus * 4 / 5 ))}"
targets=()
for abi in $abis; do targets+=(-t "$abi"); done

nice -n 19 cargo ndk "${targets[@]}" -o target/jniLibs build --release --lib -j "$jobs"
nice -n 19 cargo build --lib -j "$jobs"
nice -n 19 cargo run -j "$jobs" --features bindgen --bin uniffi-bindgen -- generate \
  --library target/debug/libnative_poseidon.so --language kotlin --no-format --out-dir target/kotlin

rm -rf "$here/src/main/jniLibs" && cp -r target/jniLibs "$here/src/main/jniLibs"
rm -rf "$here/src/main/java/uniffi" && cp -r target/kotlin/uniffi "$here/src/main/java/uniffi"
for abi in $abis; do ls -l "$here/src/main/jniLibs/$abi/libnative_poseidon.so"; done
echo "built $abis into $here/src/main/jniLibs"
