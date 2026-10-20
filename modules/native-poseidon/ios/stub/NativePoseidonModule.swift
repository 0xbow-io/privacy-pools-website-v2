import ExpoModulesCore

/// Compiled instead of ../NativePoseidonModule.swift while the Rust
/// xcframework is not in ios/ (it is built on macOS, by CI, see the podspec).
/// It registers under another name, so requireOptionalNativeModule
/// ('NativePoseidon') returns null and the app hashes with poseidon-lite.
public class NativePoseidonModule: Module {
  public func definition() -> ModuleDefinition {
    Name("NativePoseidonUnavailable")
  }
}
