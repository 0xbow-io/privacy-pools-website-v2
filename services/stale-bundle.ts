// Recognise "the page is running an older build than the server".
//
// Every lazy `import()` in the app resolves through Metro's module graph by a
// numeric id. Restart or rebuild the dev server while a tab stays open and those
// ids no longer line up, so the next dynamic import fails with "Requiring unknown
// module 5207" (Metro), or "Loading chunk … failed" / "Importing a module script
// failed" on a production bundle behind a deploy.
//
// The failure surfaces wherever the import happened to be, so it reads as a
// problem with that feature: QA saw "Couldn't verify keystore registration:
// Requiring unknown module 5207", which says nothing about the keystore and
// everything about a stale tab. Naming it costs one reload instead of a hunt.

const STALE_BUNDLE = /Requiring unknown module|Loading chunk \S+ failed|Importing a module script failed|Failed to fetch dynamically imported module/i;

/** True when the message is a module/chunk load failure rather than a real fault. */
export function isStaleBundleError(message: string): boolean {
  return STALE_BUNDLE.test(message);
}

/** The message to show instead, or null when this is a genuine failure. */
export function staleBundleMessage(message: string): string | null {
  return isStaleBundleError(message)
    ? 'The app was updated while this tab was open. Reload the page and try again.'
    : null;
}
