// React Native ships a global WebSocket; the Node `ws` package cannot run on device.
module.exports = globalThis.WebSocket;
module.exports.default = globalThis.WebSocket;
module.exports.WebSocket = globalThis.WebSocket;
