import ExpoModulesCore

/// circomlib's Poseidon over BN254 in Rust (see ../rust). Hex in, hex out:
/// every element is 64 hex characters, concatenated.
///
/// `hash` and `hashBatch` are synchronous (JSI), because the SDK's hash is
/// synchronous. `hashBatchAsync` runs a large batch off the JS thread.
/// poseidonHex / poseidonBatchHex come from UniFFI's native_poseidon.swift,
/// generated with the xcframework by build-xcframework.sh.
public class NativePoseidonModule: Module {
  public func definition() -> ModuleDefinition {
    Name("NativePoseidon")

    Function("hash") { (inputsHex: String) throws -> String in
      try poseidonHex(inputsHex: inputsHex)
    }

    Function("hashBatch") { (arity: Int, inputsHex: String) throws -> String in
      try poseidonBatchHex(arity: UInt32(clamping: arity), inputsHex: inputsHex)
    }

    AsyncFunction("hashBatchAsync") { (arity: Int, inputsHex: String) throws -> String in
      try poseidonBatchHex(arity: UInt32(clamping: arity), inputsHex: inputsHex)
    }
  }
}
