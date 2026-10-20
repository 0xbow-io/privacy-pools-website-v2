require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'NativePoseidon'
  s.version        = package['version']
  s.summary        = package['description']
  s.license        = package['license']
  s.author         = '0xbow'
  s.homepage       = 'https://github.com/0xbow-io/privacy-pools-website-v2'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/0xbow-io/privacy-pools-website-v2.git' }
  # The Rust core ships as a dynamic framework (see build-xcframework.sh), which
  # CocoaPods embeds; the Swift module itself stays static like other Expo pods.
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # The xcframework and UniFFI's native_poseidon.swift are built on macOS
  # (ios/build-xcframework.sh, or the native-poseidon CI artifact dropped into
  # ios/). Until both are here, a stub module compiles instead, so an iOS build
  # never breaks on a missing binary; the app then hashes with poseidon-lite.
  xcframework = 'native_poseidonFFI.xcframework'
  if File.exist?(File.join(__dir__, xcframework)) && File.exist?(File.join(__dir__, 'native_poseidon.swift'))
    s.source_files = '*.swift'
    s.vendored_frameworks = xcframework
  else
    s.source_files = 'stub/*.swift'
  end
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
