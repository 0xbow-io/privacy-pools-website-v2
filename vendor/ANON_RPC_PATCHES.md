# Browser harness cancellation patch

`0xbow-anon-rpc-rs-browser-harness-0.4.0-alpha.1-cancel-bootstrap.tgz`
contains the original `0.4.0-alpha.1` package plus
[`../patches/anon-rpc-browser-harness-cancel-bootstrap.patch`](../patches/anon-rpc-browser-harness-cancel-bootstrap.patch).
The original tarball is retained as the patch base. This is a local artifact;
the package version remains upstream's version. No worker bundle or hash pin
changes.

Upstream `close()` rejects `ready`, but its asynchronous bootstrap can still
finish a bundle download and create an iframe after the caller closes it.
The patch gives bootstrap a lifetime signal, aborts HTTP and KPS downloads,
stops resolver retries, and checks cancellation before iframe creation and
worker initialization, and makes the wait for the iframe's ready message
reject on close. Both the shipped `dist/host.js` and its source are
patched. Remove this patch when a newer vendored harness includes the fix.

To reproduce the artifact, extract the original tarball, apply the patch with
`git apply` from the extracted `package/` directory, and archive that directory
as the new tarball. Keep both the dependency and override in `package.json`
pointing at the patched artifact, then update `bun.lock` with
`safewrap bun install --ignore-scripts`.

`services/__tests__/tor.test.ts` exercises the installed bundle with delayed
resolver responses and response bodies. Both tests fail with the original
artifact because a closed worker creates an iframe. A third closes the worker
while the iframe has not yet said ready and checks that the wait ends.
