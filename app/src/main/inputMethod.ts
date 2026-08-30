export interface CaptureResult {
  code: number
  stdout: string
  stderr: string
}

export type InputMethodHealth =
  | { status: 'not-applicable' }
  | { status: 'healthy'; socketPath: string | null }
  | { status: 'stale'; reason: string }

export type IbusAddress =
  | { kind: 'path'; path: string }
  | { kind: 'abstract' }

interface RunOptions {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  run: (cmd: string, args: string[]) => Promise<CaptureResult>
}

interface InspectOptions extends RunOptions {
  isSocket: (path: string) => Promise<boolean>
}

interface RepairOptions extends InspectOptions {
  delay: (ms: number) => Promise<void>
  attempts?: number
}

function decodeAddressValue(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

/** Parse the unix forms IBus documents through its D-Bus address output. */
export function parseIbusAddress(raw: string): IbusAddress | null {
  const address = raw.trim()
  if (address.length === 0 || address === '(null)') return null
  const path = /(?:^|;)unix:path=([^,;]+)/.exec(address)?.[1]
  if (path) {
    const decoded = decodeAddressValue(path)
    return decoded ? { kind: 'path', path: decoded } : null
  }
  if (/(?:^|;)unix:abstract=[^,;]+/.test(address)) return { kind: 'abstract' }
  return null
}

function ibusSelected(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  if (platform !== 'linux' || !env['DISPLAY']) return false
  return [env['XMODIFIERS'], env['GTK_IM_MODULE'], env['QT_IM_MODULE']]
    .some((value) => value?.toLowerCase().includes('ibus'))
}

const INPUT_ENV_KEYS = ['XMODIFIERS', 'GTK_IM_MODULE', 'QT_IM_MODULE'] as const

/**
 * A repository-driven/raw AppImage launch may inherit DISPLAY but omit GNOME's
 * input-method markers. Recover only those missing markers from the systemd
 * user manager; never eval its output and never override an explicit choice.
 */
export async function resolveLinuxInputEnvironment(options: RunOptions): Promise<NodeJS.ProcessEnv> {
  const launchEnv = { ...options.env }
  if (options.platform !== 'linux' || !launchEnv['DISPLAY']) return launchEnv
  if (INPUT_ENV_KEYS.some((key) => launchEnv[key] !== undefined)) return launchEnv

  const result = await options.run('systemctl', ['--user', 'show-environment'])
  if (result.code !== 0) return launchEnv
  for (const line of result.stdout.split('\n')) {
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const key = line.slice(0, separator)
    if (!INPUT_ENV_KEYS.includes(key as typeof INPUT_ENV_KEYS[number])) continue
    launchEnv[key] = line.slice(separator + 1)
  }
  return launchEnv
}

/**
 * Detect the failure seen after deployment: a live ibus-daemon whose registry
 * still names an unlinked unix socket. systemd sees a healthy process, while
 * newly launched Chromium clients cannot connect and eventually drop keys.
 */
export async function inspectLinuxInputMethod(options: InspectOptions): Promise<InputMethodHealth> {
  if (!ibusSelected(options.platform, options.env)) return { status: 'not-applicable' }

  const result = await options.run('ibus', ['address'])
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim()
    return { status: 'stale', reason: detail ? `Could not query IBus: ${detail}` : 'Could not query IBus' }
  }

  const address = parseIbusAddress(result.stdout)
  if (!address) return { status: 'stale', reason: 'IBus did not publish a usable address' }
  if (address.kind === 'abstract') return { status: 'healthy', socketPath: null }
  if (await options.isSocket(address.path)) return { status: 'healthy', socketPath: address.path }
  return { status: 'stale', reason: `IBus points to a missing socket: ${address.path}` }
}

/** Restart through IBus's documented GNOME/systemd path, then prove recovery. */
export async function repairLinuxInputMethod(options: RepairOptions): Promise<InputMethodHealth> {
  const restarted = await options.run('ibus', ['restart', '--type=systemd'])
  if (restarted.code !== 0) {
    const detail = (restarted.stderr || restarted.stdout).trim()
    return { status: 'stale', reason: detail ? `Could not restart IBus: ${detail}` : 'Could not restart IBus' }
  }

  const attempts = options.attempts ?? 30
  let health: InputMethodHealth = { status: 'stale', reason: 'IBus did not recover in time' }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    health = await inspectLinuxInputMethod(options)
    if (health.status === 'healthy') return health
    if (attempt + 1 < attempts) await options.delay(100)
  }
  return health.status === 'stale'
    ? { status: 'stale', reason: `IBus restart completed, but input is still unavailable: ${health.reason}` }
    : { status: 'stale', reason: 'IBus restart completed, but input is still unavailable' }
}
