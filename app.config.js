// Dynamic Expo config wrapping the static app.json.
//
// The ONLY dynamic behavior is the visual-harness router-root override:
// PPV2_NW_GALLERY=1 serves the NativeWind compatibility gallery
// (scripts/visual/gallery-app) as the router root instead of the production
// app/ tree — so the gallery is never a production route and its utilities
// never enter the production CSS (see tailwind.config.js, which gates the
// gallery content globs on the same variable). Production builds/exports
// never set the variable and resolve to app.json unchanged.
module.exports = ({ config }) => {
  if (process.env.PPV2_NW_GALLERY === '1') {
    return {
      ...config,
      extra: {
        ...(config.extra ?? {}),
        router: { ...(config.extra?.router ?? {}), root: 'scripts/visual/gallery-app' },
      },
    };
  }
  return config;
};
