import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { BrowserDaemonWatcher } from '../../src/main/browserDaemonWatcher'
import { Connection } from '../../src/client/connection'
import { encode, type Frame } from '../../src/shared/proto'
import { loadLayoutFile, saveLayoutFile } from '../../src/main/layoutIO'
import { TabBrowserStateStore } from '../../src/main/tabBrowserStateStore'
import { commitBrowserLayoutMutation } from '../../src/main/tabBrowserMigrationCoordinator'
import { type BrowserRecord } from '../../src/shared/tabBrowserState'

const rootDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const peerPath = join(rootDir, 'test', 'process-fixtures', 'resident-peer.mjs')
const transactionPath = join(rootDir, 'test', 'process-fixtures', 'sidecar-transaction-child.ts')
const viteNodePath = join(rootDir, 'node_modules', 'vite-node', 'vite-node.mjs')
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function encoded(frame: Frame): string {
  return Buffer.from(encode(frame)).toString('base64')
}

function sessions(name: string): Frame {
  return { type: 'control', msg: { kind: 'Sessions', sessions: [{ name, cwd: '/', kind: 'pi', alive: true }] } }
}

async function waitForLine(child: ChildProcess, expected: string, timeoutMs = 2_000): Promise<void> {
  let output = ''
  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined
    const finish = (error?: Error): void => {
      if (timer) clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.off('exit', onExit)
      if (error) reject(error); else resolve()
    }
    const onData = (chunk: Buffer): void => {
      output += chunk.toString()
      if (output.includes(expected)) finish()
    }
    const onExit = (_code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new Error(`peer exited before ${expected}: ${output} (${signal ?? 'no signal'})`))
    }
    timer = setTimeout(() => finish(new Error(`timed out waiting for ${expected}: ${output}`)), timeoutMs)
    child.stdout?.on('data', onData)
    child.once('exit', onExit)
  })
}

interface ChildResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

function waitForExit(child: ChildProcess, timeoutMs = 3_000): Promise<ChildResult> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode, stdout: '', stderr: '' })
  let stdout = ''; let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child process did not exit before deadline')), timeoutMs)
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }) })
  })
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  try { await waitForExit(child, 1_500) }
  catch {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await waitForExit(child, 1_500).catch(() => {})
  }
}

async function spawnPeer(args: string[]): Promise<ChildProcess> {
  const child = spawn(process.execPath, [peerPath, ...args], { cwd: rootDir, stdio: ['ignore', 'pipe', 'pipe'] })
  await waitForLine(child, 'ready')
  return child
}

async function runTransactionChild(args: string[]): Promise<void> {
  const child = spawn(process.execPath, [viteNodePath, transactionPath, ...args], { cwd: rootDir, stdio: ['ignore', 'pipe', 'pipe'] })
  const result = await waitForExit(child)
  if (result.code !== 0) throw new Error(`transaction child failed: ${result.stderr || result.stdout || result.signal}`)
}

async function waitUntil(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('condition did not become true before deadline')
}

const baseLayout = JSON.stringify({ version: 2, activeWorkspace: 1, browserRevision: 0, workspaces: { '1': { activeTab: 1, tabs: { '1': { tree: null } } } } })

function browserLayout(id: string): string {
  return JSON.stringify({ version: 2, activeWorkspace: 1, browserRevision: 1, workspaces: { '1': { activeTab: 1, tabs: { '1': { tree: null, browser: { id, width: 420, collapsed: false } } } } } })
}

function orphanRecord(id: string): BrowserRecord {
  return {
    id: id as BrowserRecord['id'], profileId: 'global', mode: 'browse', safeRestoreUrl: 'about:blank', title: '', viewport: { width: 1280, height: 800 },
    lifecycle: 'frozen', stateRevision: 1, lastUsedAt: 1, lastFocusedAt: 0,
  }
}

describe('resident process lifecycle integration', () => {
  it('drops stale daemon authority across a real socket disconnect/reconnect epoch', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'amber-resident-process-')); roots.push(root)
    const socketPath = join(root, 'watch.sock')
    const peer = await spawnPeer([ 'watcher', socketPath, encoded(sessions('old')), encoded(sessions('new')) ])
    const connection = new Connection(socketPath)
    const watcher = new BrowserDaemonWatcher(connection, Date.now, 5_000, 10_000)
    try {
      watcher.start()
      await waitUntil(() => watcher.controller('new') !== undefined)
      expect(watcher.controller('old')).toBeUndefined()
      expect(watcher.controller('new')).toMatchObject({ kind: 'pi', alive: true })
    } finally {
      watcher.close()
      await stopChild(peer)
    }
  })

  it('keeps a concurrent sidecar writer from clobbering state and removes the orphan', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'amber-resident-cas-')); roots.push(root)
    const layoutPath = join(root, 'ui-layout.json'); await saveLayoutFile(layoutPath, baseLayout, null)
    const orphanId = 'browser-cccccccccccccccccccccccccccccccc'
    const externalLayout = JSON.stringify({ ...JSON.parse(baseLayout) as Record<string, unknown>, browserRevision: 7 })
    const store = new TabBrowserStateStore(root)
    const result = await commitBrowserLayoutMutation(layoutPath, store, browserLayout(orphanId), baseLayout, async (path, text, expected) => {
      const peer = spawn(process.execPath, [peerPath, 'write-layout', path, Buffer.from(externalLayout).toString('base64')], { cwd: rootDir, stdio: ['ignore', 'pipe', 'pipe'] })
      const childResult = await waitForExit(peer)
      if (childResult.code !== 0) throw new Error(`sidecar peer failed: ${childResult.stderr}`)
      return saveLayoutFile(path, text, expected)
    }, () => 'cas-process', (state) => ({ ...state, records: { ...state.records, [orphanId]: orphanRecord(orphanId) } }))
    expect(result).toMatchObject({ conflict: true })
    expect((await loadLayoutFile(layoutPath)).text).toBe(externalLayout)
    const state = await new TabBrowserStateStore(root).load()
    expect(state.pendingTransaction).toBeUndefined()
    expect(state.records[orphanId]).toBeUndefined()
  })

  it('recovers one staged transaction after the writer process exits, without duplicate browser records', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'amber-resident-restart-')); roots.push(root)
    const layoutPath = join(root, 'ui-layout.json'); await saveLayoutFile(layoutPath, baseLayout, null)
    const browserId = 'browser-dddddddddddddddddddddddddddddddd'
    const target = browserLayout(browserId)
    await runTransactionChild(['stage-crash', root, layoutPath, Buffer.from(target).toString('base64'), browserId])
    const staged = await new TabBrowserStateStore(root).load()
    expect(staged.pendingTransaction?.layoutText).toBe(target)
    expect(staged.records[browserId]).toEqual(orphanRecord(browserId))

    await runTransactionChild(['recover', root, layoutPath])
    expect((await loadLayoutFile(layoutPath)).text).toBe(target)
    const recovered = await new TabBrowserStateStore(root).load()
    expect(recovered.pendingTransaction).toBeUndefined()
    expect(Object.keys(recovered.records)).toEqual([browserId])
  })
})
