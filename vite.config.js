// Vite config for the Locus presentation layer.
//
// M3c (three-repo switch): the page is ONE ESM entry — main.js imports
// the two cores through src/product/{runtime-api,harness-api}.js and the
// Product modules explicitly; Vite bundles all of it. The old classic
// Runtime/Harness scripts are NOT loaded and NOT copied anymore (the
// in-repo duplicate cores were deleted at integration). M3c integration
// (agent D): telemetry.js and ui/markdown.js are ES modules as well —
// ZERO classic page scripts remain, so nothing is copied verbatim into
// dist anymore.
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  base: './',
  plugins: [vue()],
  build: {
    target: 'es2020',
    outDir: 'dist',
    // M2a: the standalone runtime host (tests/runtime-host.html) is a REAL
    // build input so the gates run the packaged entry/worker-asset bundle,
    // not the dev-server sources.
    // M2b review round: the standalone HARNESS host (tests/harness-host.html)
    // likewise — the browser gate runs the packaged harness entry chunk.
    rollupOptions: {
      input: {
        main: 'index.html',
        runtimeHost: 'tests/runtime-host.html',
        harnessHost: 'tests/harness-host.html',
        // M3c review round C: the storage-adapter PACKAGED-BUILD gate host
        // (tests/e2e-m3c-storage-built.cjs drives dist/tests/
        // m3c-storage-host.html through vite preview). The five converted
        // Product storage modules + the two product API layers as a real
        // build input, so that gate runs the bundled artifacts — its
        // source-ESM counterpart (e2e-m3c-storage-adapters.cjs) stays
        // independent of the build by design.
        storageHost: 'tests/m3c-storage-host.html',
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
});
