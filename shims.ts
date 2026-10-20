import { Buffer } from 'buffer';
import { Platform } from 'react-native';

// Buffer polyfill for web (needed by snarkjs/ffjavascript in the SDK)
if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = Buffer;
}

const getRandomValuesNative = Platform.OS !== 'web'
  ? require('react-native-get-random-values').getRandomValues
  : null;

function installCryptoPolyfill() {
  const existingCrypto = (globalThis as any).crypto;
  const getRandomValues = typeof existingCrypto.getRandomValues === 'function'
    ? existingCrypto.getRandomValues.bind(existingCrypto)
    : (buffer: ArrayBufferView) => {
        if (!getRandomValuesNative) {
          throw new Error('crypto.getRandomValues is unavailable in this environment');
        }
        return getRandomValuesNative(buffer);
      };

  const randomFillSync = <T extends ArrayBufferView>(buffer: T, offset = 0, size = buffer.byteLength - offset): T => {
    const view = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, size);
    getRandomValues(view);
    return buffer;
  };

  if (!existingCrypto) {
    (globalThis as any).crypto = {
      getRandomValues,
      randomFillSync,
    };
    return;
  }

  if (typeof existingCrypto.randomFillSync !== 'function') {
    try {
      existingCrypto.randomFillSync = randomFillSync;
    } catch {
      // Ignore on platforms where crypto is readonly; callers should use
      // getRandomValues when process.browser is set.
    }
  }
}

// ffjavascript checks process.browser to decide whether to use Web Crypto.
if (Platform.OS === 'web') {
  const existingProcess = (globalThis as any).process ?? {};
  (globalThis as any).process = {
    ...existingProcess,
    browser: true,
  };
}

installCryptoPolyfill();

// Only apply these additional shims on native platforms (iOS/Android)
if (Platform.OS !== 'web') {
  // Polyfill TextEncoder (Required by Viem/Wagmi on native)
  if (typeof global.TextEncoder === 'undefined') {
    global.TextEncoder = require('text-encoding').TextEncoder;
  }

  // Polyfill TextDecoder (Required by Viem/Wagmi on native)
  if (typeof global.TextDecoder === 'undefined') {
    global.TextDecoder = require('text-encoding').TextDecoder;
  }
}
