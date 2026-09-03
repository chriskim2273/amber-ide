import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// Spike build target — docs/superpowers/specs/2026-08-01-amber-ide-as-a-webapp-design.md
// §2.2/§8: the real renderer + `src/web/amber.ts` shim, bundled standalone (no
// Electron, no Node builtins, no CDN refs) for `amber web` to eventually embed
// with `include_bytes!` (spec §2.3). Separate from `electron.vite.config.ts`
// (which builds the desktop main/preload/renderer trio) — independent target.
export default defineConfig({
  root: resolve('src/web'),
  plugins: [react()],
  build: {
    // Keep native destructuring in the split dynamic-import bootstrap. The
    // esbuild target matrix cannot lower destructuring inside Vite's preload
    // wrapper, so selecting modern browsers makes the web build deterministic
    // instead of failing during transpilation.
    target: 'esnext',
    outDir: resolve('out/web'),
    emptyOutDir: true,
  },
})
