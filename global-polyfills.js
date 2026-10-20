// This file is loaded by Metro before any application code.
// It polyfills Node.js globals needed by snarkjs/ffjavascript on web.
var g =
  typeof globalThis !== 'undefined'
    ? globalThis
    : typeof window !== 'undefined'
      ? window
      : typeof global !== 'undefined'
        ? global
        : this;

if (typeof g.Buffer === 'undefined') {
  try {
    var Buffer = require('buffer').Buffer;
    g.Buffer = Buffer;
    if (typeof global !== 'undefined' && typeof global.Buffer === 'undefined') {
      global.Buffer = Buffer;
    }
  } catch (e) {
    // buffer package failed to load — log so we notice in dev
    if (typeof console !== 'undefined' && console.error) {
      console.error('Failed to load buffer polyfill:', e);
    }
  }
}

if (typeof g.process === 'undefined') {
  try {
    g.process = require('process');
  } catch (e) {
    g.process = { env: {}, version: '', nextTick: function (cb) { setTimeout(cb, 0); } };
  }
}

if (g.process && typeof g.process.env === 'undefined') {
  g.process.env = {};
}
