// Load polyfills synchronously before the router/app loads, so
// snarkjs/ffjavascript can find Buffer/process globals on web.
require('./global-polyfills.js');
// Native-only globals (Event, Intl.PluralRules, window.location, window events):
// native-polyfills.native.js on device, an empty file on web. Required here, not
// from global-polyfills.js, because that file also runs as a Metro polyfill with
// no module system.
require('./native-polyfills');
// Register UI-only history handling before the router installs its listener.
// Importing it from screens is too late in optimized production bundles.
require('./components/ui-url-events');
require('expo-router/entry');
