#!/usr/bin/env node
// Assert that a REAL XTest key reaches xterm. CDP is observation-only here;
// using Input.dispatchKeyEvent would bypass the IBus layer under test.
import { spawnSync } from 'node:child_process'

const [port, display, xid, offsetXRaw, offsetYRaw, helper] = process.argv.slice(2)
if (!port || !display || !xid || !offsetXRaw || !offsetYRaw || !helper) {
  throw new Error('usage: cdp-x11-input-smoke.mjs PORT DISPLAY XID OFFSET_X OFFSET_Y HELPER')
}
const offsetX = Number(offsetXRaw)
const offsetY = Number(offsetYRaw)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((target) => target.type === 'page')
if (!page) throw new Error('Electron renderer target not found')

const socket = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 0
const pending = new Map()
socket.onmessage = (event) => {
  const message = JSON.parse(event.data)
  if (!message.id) return
  pending.get(message.id)?.(message)
  pending.delete(message.id)
}
await new Promise((resolve) => { socket.onopen = resolve })
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId
  pending.set(id, (message) => message.error ? reject(message.error) : resolve(message.result))
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) =>
  (await command('Runtime.evaluate', { expression, returnByValue: true })).result.value

let ready = false
for (let attempt = 0; attempt < 150; attempt += 1) {
  ready = await evaluate("!!document.querySelector('.pane .xterm-rows')")
  if (ready) break
  await sleep(100)
}
if (!ready) throw new Error('xterm DOM renderer did not become ready')

const target = await evaluate(`(() => {
  const pane = [...document.querySelectorAll('.pane')]
    .find((candidate) => candidate.querySelector('.xterm-rows') && !candidate.querySelector('.frozen-overlay'))
  if (!pane) return null
  const rect = pane.querySelector('.xterm').getBoundingClientRect()
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
})()`)
if (!target) throw new Error('no writable terminal pane found')

const text = () => evaluate("document.querySelector('.pane .xterm-rows')?.textContent")
const stableText = async () => {
  let previous = await text()
  let stableSamples = 0
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(100)
    const current = await text()
    if (current === previous) {
      stableSamples += 1
      if (stableSamples === 3) return current
    } else {
      previous = current
      stableSamples = 0
    }
  }
  throw new Error('terminal output did not settle before the input smoke')
}
const before = await stableText()
const send = (key) => {
  const result = spawnSync(helper, [display, xid, String(Math.round(offsetX + target.x)), String(Math.round(offsetY + target.y)), key], {
    stdio: 'inherit',
  })
  if (result.status !== 0) throw new Error(`XTest helper failed for ${key}`)
}

send('x')
let after = before
for (let attempt = 0; attempt < 20 && after === before; attempt += 1) {
  await sleep(100)
  after = await text()
}
if (after === before) throw new Error('real XTest key did not change xterm output')

// Clear the private shell line in one deterministic gesture. BackSpace is not
// sufficient here because xterm's DOM cursor occupies a separate rendered cell
// while the physical key is in flight.
send('Ctrl+u')
let restored = after
for (let attempt = 0; attempt < 20 && restored !== before; attempt += 1) {
  await sleep(100)
  restored = await text()
}
if (restored !== before) {
  throw new Error(`Ctrl+U did not restore the terminal after the smoke key (before=${JSON.stringify(before?.slice(-80))}, after=${JSON.stringify(after?.slice(-80))}, restored=${JSON.stringify(restored?.slice(-80))})`)
}

console.log('desktop X11 input smoke: PASS')
socket.close()
