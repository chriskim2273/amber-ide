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
 * How long after launch a GPU/renderer death still counts as evidence that this
 * machine cannot do hardware GL at all.
 *
 * The detector exists for ONE failure: Chromium can't bring up a working
 * GPU/renderer on this box (the kernel-6.17 shm/seccomp trap), which shows up
 * immediately at startup. It is NOT a general crash handler, and it was
 * registered for the whole life of the process.
 *
 * Measured on a live machine: at 03:55:38 an X-server/NVIDIA glitch took out all
 * 16 Firefox processes, hung Discord's web contents, and killed amber's GPU
 * process ("GPU process exited unexpectedly: exit_code=512"). Amber read that as
 * "no GPU here", wrote the sticky marker, and relaunched itself into SwiftShader
 * — then burned ~11 cores for the next 23 hours with an idle RTX 3070 in the
 * box. That is the "it gets laggy after a while" report: the app silently
 * downgraded itself mid-session over an unrelated desktop-wide event.
 */
export const DETECT_WINDOW_MS = 20_000

/**
 * Does a process death say anything about this machine's GL support?
 *
 * A process the OS killed does not: an OOM kill is about memory pressure, and a
 * plain kill is about whoever sent the signal. Neither is a reason to give up on
 * the GPU. Paired with `DETECT_WINDOW_MS`, which is the load-bearing guard.
 */
export function compatWorthyReason(reason: string): boolean {
  return reason !== 'clean-exit' && reason !== 'oom' && reason !== 'killed'
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
