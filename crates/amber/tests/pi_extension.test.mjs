// Run with node --test crates/amber/tests/pi_extension.test.mjs (Node 24+).
// Execute the shipped extension factory without loading Pi or user extensions.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

function fixture() {
  const source = readFileSync(new URL('../src/pi.rs', import.meta.url), 'utf8')
    .split('const EXTENSION_TS: &str = r#"')[1].split('"#;')[0];
  const handlers = new Map();
  const process = new EventEmitter();
  process.env = { AMBER_SESSION: 'pane', AMBER_BIN: '/fake/amber' };
  process.pid = 123;
  process.platform = 'linux';
  const calls = [];
  function spawn(bin, argv) {
    const child = new EventEmitter();
    child.kill = () => {};
    child.stdin = new EventEmitter();
    child.stdin.end = (data) => {
      calls.push({ bin, argv, data: JSON.parse(data), child });
      setImmediate(() => child.emit('close', 0));
    };
    return child;
  }
  const js = stripTypeScriptTypes(source).replace(/import \{ spawn \} from [^\n]+/, '')
    .replace('export default function', 'globalThis.factory = function');
  const sandbox = { process, spawn, setTimeout, clearTimeout, setImmediate, console };
  vm.runInNewContext(js, sandbox);
  sandbox.factory({ on: (event, handler) => handlers.set(event, handler) });
  const ctx = { cwd: '/project', sessionManager: {
    getSessionId: () => 'parent-id', getSessionFile: () => '/project/parent.jsonl',
  }};
  return { calls, handlers, process, ctx };
}

test('start awaits exact-file hook completion', async () => {
  const f = fixture();
  const result = f.handlers.get('session_start')({}, f.ctx);
  assert.equal(typeof result?.then, 'function', 'hook must be awaited to keep Pi parent alive');
  await result;
  assert.equal(f.calls[0].data.session_file, '/project/parent.jsonl');
  assert.equal(f.calls[0].data.agent_kind, 'pi');
});

test('explicit quit records quit and cleans signal listeners', async () => {
  const f = fixture();
  await f.handlers.get('session_start')({}, f.ctx);
  await f.handlers.get('session_shutdown')({ reason: 'quit' }, f.ctx);
  assert.equal(f.calls.at(-1).data.event, 'quit');
  assert.equal(f.process.listenerCount('SIGTERM'), 0);
});

for (const signal of ['SIGTERM', 'SIGHUP']) {
  test(`${signal} shutdown must preserve recovery, even when Pi shutdown handler runs first`, async () => {
    const f = fixture();
    await f.handlers.get('session_start')({}, f.ctx);
    let done;
    f.process.prependListener(signal, () => {
      done = f.handlers.get('session_shutdown')({ reason: 'quit' }, f.ctx);
    });
    f.process.emit(signal);
    await done;
    assert.equal(f.calls.length, 1, 'signal shutdown must not send quit');
  });
}

test('reload and session switching do not clear the recording', async () => {
  for (const reason of ['reload', 'new', 'resume', 'fork']) {
    const f = fixture();
    await f.handlers.get('session_start')({}, f.ctx);
    await f.handlers.get('session_shutdown')({ reason }, f.ctx);
    assert.equal(f.calls.length, 1);
    assert.equal(f.process.listenerCount('SIGTERM'), 0);
  }
});
