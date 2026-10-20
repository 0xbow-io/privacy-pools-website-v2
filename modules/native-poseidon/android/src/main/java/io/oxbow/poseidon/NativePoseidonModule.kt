package io.oxbow.poseidon

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import uniffi.native_poseidon.poseidonBatchHex
import uniffi.native_poseidon.poseidonHex

/**
 * circomlib's Poseidon over BN254 in Rust (see ../../../../../../rust). Hex in,
 * hex out: every element is 64 hex characters, concatenated.
 *
 * `hash` and `hashBatch` are synchronous (JSI), because the SDK's hash is
 * synchronous. `hashBatchAsync` runs a large batch off the JS thread.
 *
 * A missing library (an ABI that was not built) is a JNA UnsatisfiedLinkError,
 * an Error rather than an Exception, so it is turned into a JS exception here;
 * the JS side then falls back to poseidon-lite.
 */
class NativePoseidonModule : Module() {
  // Only what a missing or mismatched library, or a bad input, can throw:
  // UnsatisfiedLinkError / NoClassDefFoundError / ExceptionInInitializerError
  // (all LinkageError), UniFFI's contract checks (RuntimeException) and
  // PoseidonException. Fatal JVM errors (VirtualMachineError, ...) propagate.
  private inline fun <T> guarded(block: () -> T): T =
    try {
      block()
    } catch (e: LinkageError) {
      throw CodedException("ERR_POSEIDON", e.message ?: e.toString(), e)
    } catch (e: Exception) {
      throw CodedException("ERR_POSEIDON", e.message ?: e.toString(), e)
    }

  override fun definition() = ModuleDefinition {
    Name("NativePoseidon")

    Function("hash") { inputsHex: String ->
      guarded { poseidonHex(inputsHex) }
    }

    Function("hashBatch") { arity: Int, inputsHex: String ->
      guarded { poseidonBatchHex(arity.toUInt(), inputsHex) }
    }

    AsyncFunction("hashBatchAsync") { arity: Int, inputsHex: String ->
      guarded { poseidonBatchHex(arity.toUInt(), inputsHex) }
    }
  }
}
