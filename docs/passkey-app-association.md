# Passkey app association (privacypools.com)

The app asks for passkeys with RP ID `privacypools.com` (services/passkey-eoa,
services/passkey-rp-id.ts). Android and iOS only allow that when the domain
vouches for the app. Both files are served by the v1 website repo
(0xbow-io/privacy-pools-website, base `dev`, sign-off `security@0xbow.io`).

## Android: `https://privacypools.com/.well-known/assetlinks.json`

```json
[
  {
    "relation": ["delegate_permission/common.get_login_creds"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.privacypools.v2",
      "sha256_cert_fingerprints": [
        "REPLACE_WITH_EAS_PRODUCTION_SHA256"
      ]
    }
  }
]
```

- Never list the stock React Native debug key (`android/app/debug.keystore`).
  It is shared by every project built from that template. Test on a device with
  an EAS-built APK (preview or production profile) signed with the real keystore.
- EAS production key: `eas credentials` > Android > production > Keystore,
  copy "SHA256 Fingerprint". If the app ships through Play App Signing, also add
  the "App signing key certificate" SHA-256 from Play Console > Setup > App
  integrity (Google re-signs the APK with it).
- `handle_all_urls` is not needed for passkeys (that is App Links). Add it only
  if the app also opens privacypools.com links.

## iOS: `https://privacypools.com/.well-known/apple-app-site-association`

```json
{
  "webcredentials": {
    "apps": ["REPLACE_WITH_APPLE_TEAM_ID.com.privacypools.v2"]
  }
}
```

- Team ID: developer.apple.com > Membership details, or `eas credentials` >
  iOS (it prints the Apple Team ID).
- app.json already carries `ios.associatedDomains: ["webcredentials:privacypools.com"]`.
- Apple fetches the file through its CDN: HTTPS, no redirect, no `.json`
  extension, `Content-Type: application/json`. A new file can take a while to
  reach the CDN; `?mode=developer` in the entitlement skips the CDN on a dev
  device.

## Content type on the v1 site (next.config.mjs `headers()`)

Both files have no extension, so set the type like `/.well-known/webauthn`
does (privacy-pools-website PR #232):

```js
{
  source: '/.well-known/:file(assetlinks.json|apple-app-site-association)',
  headers: [
    { key: 'Content-Type', value: 'application/json' },
    { key: 'Cache-Control', value: 'public, max-age=300' },
  ],
},
```

## Checking

- Android: `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://privacypools.com&relation=delegate_permission/common.get_login_creds`
- iOS: `https://app-site-association.cdn-apple.com/a/v1/privacypools.com`
- In the app, a missing or wrong association shows "This app build is not
  linked to privacypools.com yet."
