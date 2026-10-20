// Minimal `os` for native bundles (Android and iOS).
const { Platform } = require('react-native');
module.exports = { EOL: '\n', cpus: () => [{}], platform: () => (Platform.OS === 'ios' ? 'darwin' : 'android'), tmpdir: () => '/tmp' };
module.exports.default = module.exports;
