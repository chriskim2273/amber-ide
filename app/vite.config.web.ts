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
    outDir: resolve('out/web'),
    emptyOutDir: true,
    // es2022: the client reaches only the owner's own tailnet browsers (the
    // desktop IDE it mirrors already needs ES2022 class fields). The older
    // default target chain forced esbuild's legacy lowerings, and pre-0.28.2
    // esbuild mis-minified @xterm/xterm's `requestMode` enum bootstrap into
    // `(void 0||(s={}))` — a strict-mode ReferenceError that killed the write
    // pipeline the moment a TUI polled DECRQM (freebuff froze on start).
    target: 'es2022',
  },
})
