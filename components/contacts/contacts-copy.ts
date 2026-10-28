// Shared copy for the recipient list. Its own module because the list has a
// .web.tsx twin: on web '@/components/contacts/address-suggestions-list'
// resolves to the web file itself, so constants exported from the native file
// would import as undefined there.
export const EMPTY_TITLE = 'No saved addresses yet';
export const LOADING_TITLE = 'Looking through your activity…';
export const EMPTY_HINT = 'Paste an address. It is remembered after you withdraw or send to it.';
