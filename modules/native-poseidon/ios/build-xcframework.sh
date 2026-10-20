#!/usr/bin/env bash
# macOS only (CI: .github/workflows/native-poseidon.yml). Builds the Rust core
# as a DYNAMIC framework for device and simulator and packages it with
# UniFFI's Swift bindings, the same recipe as anon-rpc's native harness.
#
# Why dynamic: a Rust staticlib carries every crate's unlinked object code. A
# cdylib is linked, dead-stripped and stripped here, which is what an app ends
# up with anyway. The simulator slice is fat (arm64 + x86_64): a generic
# simulator build, as EAS runs it, links both architectures.
#
# Output: ios/native_poseidonFFI.xcframework and ios/native_poseidon.swift.
# With both present the podspec compiles the real module instead of the stub.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
crate="$here/../rust"
cd "$crate"

name="native_poseidonFFI"
min_ios="16.4"
export IPHONEOS_DEPLOYMENT_TARGET="$min_ios"
jobs="${JOBS:-$(( $(sysctl -n hw.ncpu) * 4 / 5 ))}"
targets=(aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios)

for target in "${targets[@]}"; do
  rustup target add "$target" >/dev/null
  cargo build --release --lib --target "$target" -j "$jobs"
done

cargo run --features bindgen --bin uniffi-bindgen -- generate \
  --library "target/aarch64-apple-ios/release/libnative_poseidon.dylib" \
  --language swift --no-format --out-dir "target/swift"

mkdir -p target/simulator
lipo -create \
  target/aarch64-apple-ios-sim/release/libnative_poseidon.dylib \
  target/x86_64-apple-ios/release/libnative_poseidon.dylib \
  -output target/simulator/libnative_poseidon.dylib

slices=(aarch64-apple-ios simulator)
frameworks=()
for slice in "${slices[@]}"; do
  platform=iPhoneOS dylib="target/$slice/release/libnative_poseidon.dylib"
  if [ "$slice" = simulator ]; then
    platform=iPhoneSimulator dylib="target/simulator/libnative_poseidon.dylib"
  fi
  fw="target/frameworks/$slice/$name.framework"
  rm -rf "$fw" && mkdir -p "$fw/Headers" "$fw/Modules"
  cp "$dylib" "$fw/$name"
  install_name_tool -id "@rpath/$name.framework/$name" "$fw/$name"
  strip -x "$fw/$name"
  cp "target/swift/$name.h" "$fw/Headers/"
  cat > "$fw/Modules/module.modulemap" <<EOF
framework module $name {
  umbrella header "$name.h"
  export *
}
EOF
  cat > "$fw/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>$name</string>
  <key>CFBundleIdentifier</key><string>io.oxbow.poseidon.ffi</string>
  <key>CFBundleName</key><string>$name</string>
  <key>CFBundlePackageType</key><string>FMWK</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleSupportedPlatforms</key><array><string>$platform</string></array>
  <key>MinimumOSVersion</key><string>$min_ios</string>
</dict>
</plist>
EOF
  frameworks+=(-framework "$fw")
done

rm -rf "$here/$name.xcframework"
xcodebuild -create-xcframework "${frameworks[@]}" -output "$here/$name.xcframework"
cp target/swift/native_poseidon.swift "$here/"
du -sh "$here/$name.xcframework"
for slice in "${slices[@]}"; do du -h "target/frameworks/$slice/$name.framework/$name"; done
lipo -info "target/frameworks/simulator/$name.framework/$name"
echo "built $here/$name.xcframework"
