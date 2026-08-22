# Third-party notices

The bundles are built from this repository's own source. The build tools
(esbuild, TypeScript, the Chrome type definitions) do not reach the
packaged output.

## x-media-grid-restore

The `__INITIAL_STATE__` accessor in `src/content/interceptor.ts`, which
patches X's feature flags before X reads them, is adapted from
x-media-grid-restore.

- Project: https://github.com/QuantumDeus/x-media-grid-restore
- Licence: MIT, Copyright (c) 2026 X Media Grid Restore contributors
