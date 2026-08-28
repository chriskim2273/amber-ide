export interface SetupResult {
  code: number
  stderr: string
}

export type SetupRunner = (args: string[]) => Promise<SetupResult>

/**
 * Repair the two app-owned agent integrations independently. A broken Codex
 * skill must not prevent Pi's idempotent extension repair (or vice versa).
 */
export async function repairAgentExtensions(
  run: SetupRunner,
  warn: (message: string) => void,
): Promise<void> {
  for (const [label, args] of [
    ['Codex skill', ['ctl', 'install-codex-skill']],
    ['Pi extension', ['ctl', 'install-pi-extension']],
  ] as const) {
    try {
      const result = await run([...args])
      if (result.stderr.length > 0) warn(result.stderr)
      if (result.code !== 0) warn(`[amber] ${label} repair failed (exit ${result.code})\n`)
    } catch (error) {
      warn(`[amber] ${label} repair failed: ${String(error)}\n`)
    }
  }
}
