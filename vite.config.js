// Vite config for the Locus presentation layer.
//
// M3c (three-repo switch): the page is ONE ESM entry — main.js imports
// the two cores through src/product/{runtime-api,harness-api}.js and the
// Product modules explicitly; Vite bundles all of it. The old classic
// Runtime/Harness scripts are NOT loaded and NOT copied anymore (the
// in-repo duplicate cores stay on disk only until D deletes them).
// Exactly two Product classic files remain page scripts (still copied
// verbatim so `dist/` keeps the same layout): telemetry.js (Product
// observability singleton; the panel reads window.Telemetry) and
// ui/markdown.js (its caller Timeline.vue reads the LocusMarkdown global;
// converting the pair is recorded for D in docs/M3C-C-HANDOFF.md).
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Remaining classic page scripts referenced by index.html.
const RUNTIME_SCRIPTS = [
  'src/telemetry.js',
  'src/ui/markdown.js',
];

function copyRuntimeScripts() {
  return {
    name: 'locus-copy-runtime-scripts',
    apply: 'build',
    closeBundle() {
      for (const rel of RUNTIME_SCRIPTS) {
        const dest = join(this.environment?.config?.root || process.cwd(), 'dist', rel);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(rel, dest);
      }
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [vue(), copyRuntimeScripts()],
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
