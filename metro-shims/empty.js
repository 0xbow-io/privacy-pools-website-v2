// Empty-module stub used by metro.config.js to short-circuit transitive
// deps Metro would otherwise drag into the web bundle even though we
// never execute the code that imports them.
//
// Concrete case: @walletconnect/ethereum-provider does
//   if (this.rpc.showQrModal) {
//     const { createAppKit } = await import("@reown/appkit/core");
//   }
// With showQrModal: false the dynamic import never runs at runtime,
// but Metro still walks the import graph and bundles @reown/appkit
// (which uses valtio's ESM entry, which uses `import.meta.env`, which
// blows up the page in prod with "Cannot use 'import.meta' outside a
// module"). Aliasing the package to this stub keeps it out of the
// graph entirely.
//
// Importers see `undefined` for whatever named export they tried to
// read. That's fine — the only call path that would have read those
// exports is the showQrModal=true branch we explicitly disabled.
module.exports = {};
module.exports.default = {};
