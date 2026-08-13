import { spawn } from 'node:child_process'

export function spawnOkWithStderr(
  cmd: string,
  args: string[],
  surface: (stderr: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let spawnError: Error | null = null
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.once('error', (error) => { spawnError = error })
    child.once('close', (code) => {
      if (spawnError !== null) return reject(spawnError)
      if (code !== 0) return reject(new Error(`${cmd} exit ${code}`))
      if (chunks.length > 0) surface(Buffer.concat(chunks).toString())
      resolve()
    })
  })
}
