These are WOFF2 encodings of the complete fonts already shipped by the pinned
Geist and Expo Vector Icons packages. No characters, icons, or font metrics are
removed. Metro uses them only on web; native retains the package's TTF assets.

To regenerate after upgrading either package, install `fonttools[woff]==4.60.2`
in a temporary Python environment, then run `python scripts/compress-web-fonts.py`.
The script checks character mappings and advance widths and records source hashes
in `sources.json`. FontTools is only needed for regeneration, not application builds.

The export step discovers hashed URLs and preloads these fonts from the HTML head.
Font loading remains managed by Expo.
