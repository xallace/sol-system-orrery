# Third-party notices

This project vendors the following dependencies so that the application runs
entirely offline.

## Astronomy Engine 2.1.19

- Upstream: https://github.com/cosinekitty/astronomy
- License: MIT
- Copyright: 2019–2023 Don Cross
- Full text: [`vendor/astronomy/LICENSE`](vendor/astronomy/LICENSE)
- Vendored file: `vendor/astronomy/astronomy.js`

## Three.js r186

- Upstream: https://threejs.org/
- License: MIT
- Copyright: 2010–2026 Three.js Authors
- Full text: [`vendor/three/LICENSE`](vendor/three/LICENSE)
- Vendored files: `vendor/three/three.module.js`, `vendor/three/three.core.js`,
  `vendor/three/addons/controls/OrbitControls.js`, and `vendor/three/addons/lines/*`

## Manrope

- Upstream: https://github.com/sharanda/manrope
- License: SIL Open Font License 1.1
- Full text: [`vendor/fonts/MANROPE-LICENSE.txt`](vendor/fonts/MANROPE-LICENSE.txt)
- Vendored file: `vendor/fonts/manrope-latin-wght-normal.woff2`

## IBM Plex Mono

- Upstream: https://github.com/IBM/plex
- License: SIL Open Font License 1.1
- Full text: [`vendor/fonts/IBM-PLEX-MONO-LICENSE.txt`](vendor/fonts/IBM-PLEX-MONO-LICENSE.txt)
- Vendored files: `vendor/fonts/ibm-plex-mono-latin-400-normal.woff2` and
  `vendor/fonts/ibm-plex-mono-latin-500-normal.woff2`

## Reference data

The validation baseline in `tests/reference-vectors.json` was obtained from the
NASA/JPL Horizons API and is included for testing and attribution. See the
README for the exact configuration and observed differences.
