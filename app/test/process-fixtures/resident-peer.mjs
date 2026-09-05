import { createServer } from 'node:net'
import { open, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const [mode, ...args] = process.argv.slice(2)

async function atomicWrite(path, text) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

if (mode === 'write-layout') {
  const [path, encoded] = args
  if (!path || !encoded) throw new Error('write-layout arguments missing')
  await atomicWrite(path, Buffer.from(encoded, 'base64').toString('utf8'))
  process.stdout.write('written\n')
} else if (mode === 'watcher') {
  const [socketPath, firstEncoded, secondEncoded] = args
  if (!socketPath || !firstEncoded || !secondEncoded) throw new Error('watcher arguments missing')
  const frames = [Buffer.from(firstEncoded, 'base64'), Buffer.from(secondEncoded, 'base64')]
  let connections = 0
  const server = createServer((socket) => {
    const index = connections++
    socket.on('error', () => {})
    socket.write(frames[Math.min(index, frames.length - 1)], () => {
      if (index === 0) setTimeout(() => socket.destroy(), 10).unref()
    })
  })
  const close = () => server.close(() => process.exit(0))
  process.once('SIGTERM', close)
  process.once('SIGINT', close)
  server.listen(socketPath, () => process.stdout.write('ready\n'))
} else {
  throw new Error(`unknown resident peer mode: ${String(mode)}`)
}
