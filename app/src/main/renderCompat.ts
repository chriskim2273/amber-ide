// Compat mode = software GL (ANGLE/SwiftShader) + relaxed sandbox + kernel-shm
// workarounds, for machines where Chromium can't do multi-process GPU/shm (the
// kernel 6.17 faccessat2 seccomp trap → the renderer never paints).
//
// It is a LAST RESORT: software rasterization of a dozen blinking terminals
// costs whole CPU cores. So the persisted marker that turns it on must not be
// permanent — see `shouldUseCompat`.

/**
 * Identity of the environment a compat decision was made in.
 *
 * The marker used to hold a bare `1`, tested with `existsSync`. That made compat
 * STICKY FOREVER: one bad launch condemned the machine to software rendering,
 * and a later kernel or Electron upgrade that fixed the underlying bug was never
 * noticed. Measured on a live machine — a marker written under kernel 6.17 was
 * still forcing SwiftShader on kernel 7.0 months later, burning ~10 cores with
 * an idle RTX 3070 sitting right there.
 *
 * Recording WHERE the decision was made lets it expire on its own: a different
 * kernel or Electron build is a different question, so we ask it again. Getting
 * that wrong is cheap and self-correcting — the GPU/renderer crash detector
 * re-writes the marker and relaunches, costing one restart.
 */
export function compatSignature(electronVersion: string, kernelRelease: string): string {
  return `electron=${electronVersion} kernel=${kernelRelease}`
}

/**
 * Should this launch use compat mode?
 *
 * `flag` is the marker file's contents, or null when it is absent.
 * An env override always wins (it is how a user or a test forces the issue).
 * A marker matching the CURRENT signature is honoured. A marker from a
 * different environment — including the legacy bare `1`, which names no
 * environment at all — is treated as stale: retry hardware GL and let the
 * crash detector re-decide.
 */
export function shouldUseCompat(
  env: Record<string, string | undefined>,
  flag: string | null,
  signature: string,
): boolean {
  if (env['AMBER_SOFTWARE_GL'] || env['AMBER_NO_SANDBOX']) return true
  if (flag === null) return false
  return flag.trim() === signature
}

/**
 * Chromium switches for compat mode.
 *
 * Note what is NOT here: `disable-gpu-vsync` and `disable-frame-rate-limit`.
 * They were added to shave a compositor frame off keystroke latency, which is a
 * win on a GPU and a catastrophe without one — uncapping the frame rate lets a
 * SOFTWARE rasterizer redraw as fast as it can, and a pane full of blinking
 * cursors damages the screen continuously. Measured: ~10 cores in the GPU
 * process, which then starved the renderer's main thread, so keystrokes queued
 * up and arrived in bursts — the very latency the switches were meant to cut.
 * Leaving vsync ON caps the cost at the display's refresh rate.
 */
export const COMPAT_SWITCHES: [string, string?][] = [
  ['use-gl', 'angle'],
  ['use-angle', 'swiftshader'],
  ['enable-unsafe-swiftshader'],
  // Sandbox/shm/kernel workarounds (the faccessat2 seccomp trap lives in the
  // zygote-set-up child namespace; --no-zygote is the one that actually fixes
  // shm allocation on kernel 6.17).
  ['no-sandbox'],
  ['disable-dev-shm-usage'],
  ['disable-seccomp-filter-sandbox'],
  ['no-zygote'],
]
