import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import vm from 'node:vm'
import { parse as parseJS } from '@babel/parser'
import { createServer } from 'vite'
import { resolveAdminEntryUrl } from '../src/frontend/router/adminEntryUrl.js'
import { harness, until, controls, openPair } from './terminal-harness.js'

const source = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('built-in admin terminal route survives a new tab and refresh without losing API index', () => {
  assert.equal(resolveAdminEntryUrl({ pathname: '/admin', hash: '#/admin/terminal/node-a?apiIndex=1' }), null)
  assert.equal(resolveAdminEntryUrl({ pathname: '/admin/', search: '?apiIndex=1', hash: '#/admin/terminal/node-a' }), '/admin#/admin/terminal/node-a?apiIndex=1')
  assert.equal(resolveAdminEntryUrl({ pathname: '/admin', hash: '#/admin/terminal/../../' }), '/admin#/admin')
})

test('terminal route and server-table actions are wired without eager xterm in the dashboard', async () => {
  const router = await source('src/frontend/router/index.js')
  const table = await source('src/frontend/views/admin/components/ServerTable.vue')
  const admin = await source('src/frontend/views/admin/index.vue')
  assert.match(router, /path: '\/admin\/terminal\/:id'/)
  assert.match(router, /component: \(\) => import\('\.\.\/views\/admin\/Terminal.vue'\)/)
  assert.match(table, /\$emit\('terminal', server\)/)
  assert.match(admin, /@terminal="openTerminal"/)
  assert.match(admin, /noopener/)
  assert.doesNotMatch(admin + table, /@xterm/)
})

test('terminal setup keeps tokens out of browser storage and supplies the installer without manual file paths', async () => {
  const modal = await source('src/frontend/views/admin/components/CopyCommandModal.vue')
  const composable = await source('src/frontend/composables/useTerminal.js')
  assert.doesNotMatch(modal + composable, /localStorage|sessionStorage|createLiveSocket|searchParams\.set/)
  assert.doesNotMatch(modal, /terminalPath|terminalRisk|usePasswordVisibility/)
  assert.match(modal, /node_read_install/)
  const admin = await source('src/frontend/views/admin/index.vue')
  assert.match(admin, /--install-node-token=/)
})

test('terminal HTTP errors preserve canonical reason without changing ordinary 401/403 policy', async () => {
  const vite = await createServer({ configFile: false, appType: 'custom', logLevel: 'silent', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, watch: null } })
  const saved = { window: globalThis.window, localStorage: globalThis.localStorage, fetch: globalThis.fetch }
  try {
    const { http } = await vite.ssrLoadModule('/src/frontend/utils/http.js')
    const removed = []; const redirected = []; const requests = []
    globalThis.window = { location: { origin: 'https://monitor.example', pathname: '/admin', reload: () => redirected.push('reload'), assign: url => redirected.push(url) } }
    globalThis.localStorage = { getItem: () => 'old-monitor-token', removeItem: key => removed.push(key) }
    let status = 401
    globalThis.fetch = async (url, init) => { requests.push(init); return Response.json({ error: status === 401 ? 'terminal_step_up_required' : 'terminal_disabled', code: status }, { status }) }
    const options = { responsePolicy: 'terminal', includeAuth: false, includeTurnstile: false, includeTurnstileVerified: false, autoRedirect: false }
    const results = []
    for (const method of [() => http.postByIndex('/admin/api', {}, 0, options), () => http.postAll('/admin/api', {}, options)]) {
      for (status of [401, 403]) {
        const response = await method()
        const result = Array.isArray(response) ? response[0] : response
        results.push({ error: result.error, status: result.status, code: result.code })
      }
    }
    assert.deepEqual({ results, removed, redirected }, { results: [
      { error: 'terminal_step_up_required', status: 401, code: 401 }, { error: 'terminal_disabled', status: 403, code: 403 },
      { error: 'terminal_step_up_required', status: 401, code: 401 }, { error: 'terminal_disabled', status: 403, code: 403 }
    ], removed: [], redirected: [] })
    assert.deepEqual(removed, [])
    assert.deepEqual(redirected, [])
    assert.ok(requests.every(request => !request.headers.Authorization && !request.headers['X-Turnstile-Token'] && !request.headers['X-Turnstile-Verified']))
    globalThis.fetch = async () => Response.json({error:'terminal_authority_or_broker_unavailable',serverRevoked:true,localConfirmed:false,localReason:'broker_unavailable'}, {status:503})
    const revoked = await http.postByIndex('/admin/api', {}, 0, options)
    assert.equal(revoked.serverRevoked, true, 'terminal failure must retain authoritative revoke without claiming local shutdown')
    assert.equal(revoked.localConfirmed, false)
    globalThis.fetch = async () => Response.json({error:status === 401 ? 'terminal_step_up_required' : 'terminal_disabled',code:status}, {status})
    status = 401; await http.post('/admin/api', {})
    assert.deepEqual(removed, ['jwt_token'])
    assert.deepEqual(redirected, ['reload'])
    status = 403; await http.post('/admin/api', {})
    assert.deepEqual(removed, ['jwt_token', 'turnstile_token', 'turnstile_verified'])
    assert.deepEqual(redirected, ['reload', 'reload'])
  } finally {
    Object.assign(globalThis, saved)
    await vite.close()
  }
})

class Socket {
  static instances = []
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.bufferedAmount = 0
    this.listeners = {}
    this.sent = []
    Socket.instances.push(this)
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) }
  emit(type, event = {}) { for (const fn of this.listeners[type] || []) fn(event) }
  send(data) { this.sent.push(typeof data === 'string' ? JSON.parse(data) : new Uint8Array(data)) }
  connect() { this.readyState = 1; this.emit('open') }
  message(data) { this.emit('message', { data: typeof data === 'object' && !(data instanceof ArrayBuffer) ? JSON.stringify(data) : data }) }
  close() { this.readyState = 3; this.emit('close', { code: 1000 }) }
}

class Screen {
  static instances = []
  constructor(options) {
    this.options = options; this.cols = 80; this.rows = 24; this.callbacks = []; this.handlers = {}; this.visible = ''
    this.buffer = { active: { viewportY: 0, getNullCell: () => ({}), getLine: row => {
      const line = this.visible.split('\n')[row] || ''
      return { getCell: col => ({ getChars: () => line[col] || '', getWidth: () => 1 }) }
    } } }
    Screen.instances.push(this)
  }
  loadAddon() {}
  open() {}
  focus() { this.focusCalls = (this.focusCalls || 0) + 1 }
  resize(cols, rows) { this.cols = cols; this.rows = rows }
  onData(fn) { this.handlers.data = fn; return { dispose() {} } }
  onBinary(fn) { this.handlers.binary = fn; return { dispose() {} } }
  onResize(fn) { this.handlers.resize = fn; return { dispose() {} } }
  attachCustomKeyEventHandler() {}
  write(data, cb) {
    this.callbacks.push({ data, cb: () => {
      if (!this.disposed) this.visible += new TextDecoder().decode(data)
      cb?.()
    } })
  }
  getSelection() { return '' }
  hasSelection() { return false }
  paste(text) { this.handlers.data?.(text) }
  dispose() { this.disposed = true }
}

async function fixture(run) {
  assert.ok(await source('src/frontend/composables/useTerminal.js'))
  const vite = await createServer({
    configFile: false, appType: 'custom', logLevel: 'silent',
    // SSR-only fixtures must not crawl old HTML evidence or contend for its dependency cache.
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, watch: null },
    ssr: { noExternal: ['@xterm/xterm', '@xterm/addon-fit'] },
    plugins: [{
      name: 'test-screen-boundary', enforce: 'pre',
      resolveId(id) { if (id.startsWith('@xterm/')) return '\0test:' + id },
      load(id) {
        if (id === '\0test:@xterm/xterm') return 'export const Terminal = globalThis.__terminalScreen'
        if (id === '\0test:@xterm/addon-fit') return 'export class FitAddon { proposeDimensions() { return {cols:80,rows:24} } fit() {} }'
        if (id.startsWith('\0test:')) return 'export default {}'
      },
      transform(code, id) {
        if (id.endsWith('/src/frontend/composables/useTerminal.js')) {
          return 'const {setTimeout, clearTimeout} = globalThis.__terminalClock;\n' + code
        }
      }
    }]
  })
  const original = {}
  const overrides = ['window', 'document', 'localStorage', 'WebSocket', 'ResizeObserver', '__terminalScreen', '__terminalClock', 'fetch', 'getComputedStyle', 'BroadcastChannel']
  for (const key of overrides) original[key] = globalThis[key]
  const calls = []
  const timers = new Map()
  let timerId = 0
  let enabled = true
  let supported = true
  let connected = true
  const sessions = []
  Socket.instances = []
  Screen.instances = []
  const controllers = []
  const logoutMessages = []
  try {
    // Only the endpoint uses this clock; Vite imports and HTTP timers stay native.
    globalThis.__terminalClock = {
      setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay, origin: new Error().stack }); return id },
      clearTimeout(id) { timers.delete(id) }
    }
    const { useTerminal } = await vite.ssrLoadModule('/src/frontend/composables/useTerminal.js')
    const api = await vite.ssrLoadModule('/src/frontend/utils/api.js')
    globalThis.window = Object.assign(new EventTarget(), { location: { origin: 'https://monitor.example', protocol: 'https:', host: 'monitor.example', pathname: '/admin', search: '', hash: '#/admin' } })
    globalThis.document = { querySelector: () => null }
    globalThis.localStorage = { getItem: () => 'monitor-jwt', removeItem() { throw new Error('Terminal must not clear monitor login storage') } }
    globalThis.WebSocket = Socket
    globalThis.__terminalScreen = Screen
    globalThis.ResizeObserver = class { observe() {} disconnect() {} }
    globalThis.BroadcastChannel = class { constructor(name) { this.name = name } close() {} postMessage(message) { logoutMessages.push({ name: this.name, message }) } }
    globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })
    globalThis.fetch = async (url, init) => {
      const data = JSON.parse(init.body)
      calls.push({ url, init, data })
      if (data.action === 'terminal_status') return Response.json({ enabled, supported, connected, protocol: 1, platform: 'linux', activeCount: 0 })
      if (data.action === 'terminal_open') {
        const sessionId = `session-${sessions.length + 1}`
        sessions.push(sessionId)
        return Response.json({ sessionId, browserPath: `/admin/api/terminal/node-a/${sessionId}/ws`, leaseUntil: Date.now() + 60000 })
      }
      return Response.json({ closed: true, leaseUntil: Date.now() + 60000 })
    }
    const tick = (maxDelay = 32) => {
      const due = [...timers].filter(([, t]) => t.delay <= maxDelay)
      for (const [id, timer] of due) { timers.delete(id); timer.fn() }
    }
    const create = (apiIndex = 0) => {
      const t = useTerminal({ serverId: 'node-a', apiIndex })
      controllers.push(t)
      return t
    }
    const open = async t => {
      const opened = await t.open({ addEventListener() {}, removeEventListener() {}, style: {} })
      if (enabled && supported && connected) assert.equal(opened, true, `terminal open failed: ${t.errorCode.value}; actions=${calls.map(call => call.data.action).join(',')}`)
      const ws = Socket.instances.at(-1)
      ws?.connect()
      ws?.message({ type: 'start', cols: 80, rows: 24 })
      ws?.message({ type: 'ready' })
      return ws
    }
    await run({ create, open, calls, tick, timers, api, logoutMessages, setState(state) { ({ enabled = enabled, supported = supported, connected = connected } = state) } })
  } finally {
    for (const t of controllers) t.dispose()
    for (const key of overrides) { if (original[key] === undefined) delete globalThis[key]; else globalThis[key] = original[key] }
    await vite.close()
  }
}

test('actual broker startup controls satisfy the unchanged strict frontend start contract', async () => {
  const h = await harness()
  try {
    const pair = await openPair(h, await h.control())
    await until(() => controls(pair.agent).some(frame => frame.type === 'start'))
    pair.agent.ws.send('{"type":"ready"}')
    await until(() => controls(pair.browser).some(frame => frame.type === 'ready'))
    const frames = controls(pair.browser)
    await fixture(async ({ create, calls }) => {
      const terminal = create()
      const opened = await terminal.open({ addEventListener() {}, removeEventListener() {}, style: {} })
      assert.equal(opened, true, `terminal open failed: ${terminal.errorCode.value}; actions=${calls.map(call => call.data.action).join(',')}`)
      const socket = Socket.instances.at(-1)
      socket.connect()
      for (const frame of frames) socket.message(frame)
      assert.equal(terminal.status.value, 'running')
      assert.equal(Screen.instances.at(-1).options.disableStdin, false)
    })
  } finally { await h.dispose() }
})

test('synthetic endpoint clocks never own cold Vite module transport timeouts', () => fixture(async ({ create, open, timers }) => {
  const nativeTimeout = globalThis.setTimeout
  await open(create())
  assert.equal(globalThis.setTimeout, nativeTimeout)
  assert.ok(timers.size > 0, 'endpoint timers remain deterministic')
  assert.ok([...timers.values()].every(timer => !timer.origin.includes('node_modules/vite/')), 'tooling timers never enter the endpoint clock')
}))

test('terminal uses selected same-origin API and Cookie only, rejecting invalid/cross-origin indices', () => fixture(async ({ api, calls }) => {
  window.__APP_API_BASES__ = ['https://other.example', 'https://monitor.example']
  await api.adminApi({ action: 'terminal_status', serverId: 'node-a' }, 1)
  assert.equal(calls[0].url, 'https://monitor.example/admin/api')
  assert.equal(calls[0].init.headers.Authorization, undefined)
  assert.equal(calls[0].init.credentials, 'include')
  for (const index of [0, 2, -1, NaN]) {
    const result = await api.adminApi({ action: 'terminal_status', serverId: 'node-a' }, index)
    assert.ok(result.error)
  }
  assert.equal(calls.length, 1)
}))

test('disabled, unsupported and disconnected nodes cannot allocate a shell', () => fixture(async ({ create, open, calls, setState }) => {
  for (const state of [{ enabled: false }, { enabled: true, supported: false }, { supported: true, connected: false }]) {
    setState(state)
    const t = create()
    await open(t)
    assert.notEqual(t.status.value, 'running')
    assert.ok(t.errorCode.value)
  }
  assert.equal(calls.filter(c => c.data.action === 'terminal_open').length, 0)
  assert.equal(Socket.instances.length, 0)
}))

test('explicit opens create independent sessions; disconnection never replays or reconnects', () => fixture(async ({ create, open, calls, tick }) => {
  const a = create(); const b = create()
  const wa = await open(a); const wb = await open(b)
  assert.notEqual(wa.url, wb.url)
  assert.equal(new URL(wa.url).search, '')
  wa.close(); tick(75000)
  assert.equal(a.status.value, 'disconnected')
  assert.equal(b.status.value, 'running')
  assert.equal(Socket.instances.length, 2)
  await open(a)
  assert.equal(Socket.instances.length, 3)
  const opens = calls.filter(c => c.data.action === 'terminal_open')
  assert.equal(new Set(opens.map(c => c.data.clientRequestId)).size, 3)
}))

test('output ACK follows actual screen consumption and batches cumulative bytes', () => fixture(async ({ create, open, tick }) => {
  const t = create(); const ws = await open(t); const screen = Screen.instances.at(-1)
  for (let i = 0; i < 100; i++) ws.message(new Uint8Array([120]).buffer)
  tick()
  assert.equal(ws.sent.filter(f => f.type === 'ack').length, 0)
  for (const write of screen.callbacks) write.cb()
  tick()
  const acks = ws.sent.filter(f => f.type === 'ack')
  assert.ok(acks.length > 0 && acks.length < 10)
  assert.equal(acks.at(-1).bytes, 100)
}))

test('input producer has 16KiB frames, 256KiB credit and no oversized paste allocation', () => fixture(async ({ create, open, tick }) => {
  const t = create(); const ws = await open(t); const screen = Screen.instances.at(-1)
  for (let i = 0; i < 16; i++) { screen.handlers.data('x'.repeat(16384)); tick() }
  assert.equal(ws.sent.filter(f => f instanceof Uint8Array).reduce((n, f) => n + f.length, 0), 262144)
  screen.handlers.data('y'); tick()
  assert.equal(ws.sent.filter(f => f instanceof Uint8Array).reduce((n, f) => n + f.length, 0), 262144)
  ws.message({ type: 'ack', bytes: 16384 }); tick()
  assert.equal(ws.sent.filter(f => f instanceof Uint8Array).at(-1)[0], 121)
  const before = ws.sent.length
  screen.handlers.data('z'.repeat(1048576)); tick()
  assert.equal(ws.sent.length, before)
  assert.equal(t.errorCode.value, 'terminal_input_overflow')
  assert.ok(ws.sent.filter(f => f instanceof Uint8Array).every(f => f.length <= 16384))
}))

test('slow S1 screen cannot block S2 keyboard echo; 100 keys are batched', () => fixture(async ({ create, open, tick }) => {
  const a = create(); const b = create(); const wa = await open(a); const sa = Screen.instances.at(-1)
  const wb = await open(b); const sb = Screen.instances.at(-1)
  for (let i = 0; i < 16; i++) wa.message(new Uint8Array(16384).buffer)
  for (let i = 0; i < 100; i++) sb.handlers.data('x')
  tick()
  const frames = wb.sent.filter(f => f instanceof Uint8Array)
  assert.ok(frames.length > 0 && frames.length < 10)
  assert.equal(frames.reduce((n, f) => n + f.length, 0), 100)
  wb.message(new Uint8Array([120]).buffer); sb.callbacks[0].cb(); tick()
  assert.equal(wb.sent.filter(f => f.type === 'ack').at(-1).bytes, 1)
  assert.equal(wa.sent.filter(f => f.type === 'ack').length, 0)
  assert.equal(sa.callbacks.reduce((n, f) => n + f.data.byteLength, 0), 262144)
}))

test('backward/beyond-sent ACK and oversized controls fail closed', () => fixture(async ({ create, open, tick }) => {
  for (const frame of [{ type: 'ack', bytes: 1 }, 'x'.repeat(4097)]) {
    const t = create(); const ws = await open(t)
    ws.message(frame); tick()
    assert.equal(ws.readyState, 3)
    assert.ok(t.errorCode.value)
  }
}))

test('page exit disposes endpoint, and lease renewal is 45 seconds not per frame', () => fixture(async ({ create, open, timers, calls }) => {
  const t = create(); const ws = await open(t)
  assert.ok([...timers.values()].some(timer => timer.delay === 45000))
  window.dispatchEvent(new Event('pagehide'))
  assert.equal(ws.readyState, 3)
  assert.equal(Screen.instances.at(-1).disposed, true)
  assert.ok(calls.some(c => c.data.action === 'terminal_close'))
}))

test('cookie-only logout broadcasts closure even when there is no stored monitor JWT', () => fixture(async ({ create, open, api, logoutMessages }) => {
  const t = create(); const ws = await open(t)
  localStorage.getItem = () => null
  localStorage.removeItem = () => {}
  api.logout()
  assert.equal(ws.readyState, 3)
  assert.equal(t.errorCode.value, 'terminal_login_required')
  assert.deepEqual(logoutMessages, [{ name: 'cfsm-terminal-logout', message: { type: 'logout' } }])
}))

test('four endpoint windows bound outstanding application data to 2MiB and isolate over-credit output', () => fixture(async ({ create, open, tick }) => {
  const peers = []
  for (let i = 0; i < 4; i++) {
    const t = create(); const ws = await open(t); const screen = Screen.instances.at(-1)
    for (let frame = 0; frame < 16; frame++) {
      screen.handlers.data('x'.repeat(16384)); tick()
      ws.message(new Uint8Array(16384).buffer)
    }
    peers.push({ t, ws, screen })
  }
  const bytes = peers.reduce((sum, p) => sum + p.ws.sent.filter(f => f instanceof Uint8Array).reduce((n, f) => n + f.byteLength, 0) + p.screen.callbacks.reduce((n, w) => n + w.data.byteLength, 0), 0)
  assert.equal(bytes, 2097152)
  peers[0].ws.message(new Uint8Array([120]).buffer)
  assert.equal(peers[0].ws.readyState, 3)
  assert.ok(peers.slice(1).every(p => p.t.status.value === 'running'))
}))

test('cancelled creation closes its late reservation without opening a WebSocket or replaying input', () => fixture(async ({ create, calls }) => {
  const oldFetch = globalThis.fetch
  let resolveOpen
  globalThis.fetch = (url, init) => JSON.parse(init.body).action === 'terminal_open' ? new Promise(resolve => { resolveOpen = resolve }) : oldFetch(url, init)
  const t = create()
  const opening = t.open({ addEventListener() {}, removeEventListener() {}, style: {} })
  // Vite's lazy module load uses real asynchronous IO, not the endpoint's fake timers.
  for (let i = 0; i < 500 && !resolveOpen; i++) await sleep(10)
  assert.equal(typeof resolveOpen, 'function')
  t.close()
  resolveOpen(Response.json({ sessionId: 'late-session', browserPath: '/admin/api/terminal/node-a/late-session/ws' }))
  await opening
  assert.equal(Socket.instances.length, 0)
  assert.ok(calls.some(c => c.data.action === 'terminal_close' && c.data.sessionId === 'late-session'))
}))

test('failed authenticated lease renewal closes rather than silently creating another shell', () => fixture(async ({ create, open, timers }) => {
  const t = create(); const ws = await open(t)
  globalThis.fetch = async () => Response.json({ error: 'terminal_authority_denied', code: 403 }, { status: 403 })
  const renewal = [...timers.values()].find(timer => timer.delay === 45000)
  renewal.fn()
  for (let i = 0; i < 100 && ws.readyState !== 3; i++) await sleep(5)
  assert.equal(ws.readyState, 3)
  assert.equal(t.errorCode.value, 'terminal_authority_denied')
  assert.equal(Socket.instances.length, 1)
}))

test('oversized binary frames and backward ACK close the offending endpoint', () => fixture(async ({ create, open, tick }) => {
  const t = create(); const ws = await open(t); const screen = Screen.instances.at(-1)
  screen.handlers.data('x'); tick()
  ws.message({ type: 'ack', bytes: 1 })
  ws.message({ type: 'ack', bytes: 0 })
  assert.equal(ws.readyState, 3)
  const another = create(); const other = await open(another)
  other.message(new Uint8Array(16385).buffer)
  assert.equal(other.readyState, 3)
}))

test('copy without a terminal selection never overwrites the operator clipboard', () => fixture(async ({ create }) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const copied = []
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async text => copied.push(text) } } })
  try {
    const t = create()
    await t.copySelection()
    assert.deepEqual(copied, [])
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor)
    else delete globalThis.navigator
  }
}))

async function pagePasteHandler(terminal, readText, uiError = { value: '' }) {
  const page = await source('src/frontend/views/admin/Terminal.vue')
  const script = page.match(/<script setup>([\s\S]*?)<\/script>/)[1]
  const ast = parseJS(script, { sourceType: 'module' })
  const declaration = ast.program.body.flatMap(node => node.declarations || []).find(node => node.id?.name === 'pasteClipboard')
  assert.ok(declaration?.init, 'actual component paste handler must be exercised')
  return vm.runInNewContext(script.slice(declaration.init.start, declaration.init.end), {
    terminal, uiError, navigator: { clipboard: { readText } }
  })
}

test('pending component clipboard input and focus cannot cross a close/reopen session boundary', () => fixture(async ({ create, open, tick }) => {
  const t = create(); await open(t)
  let resolveClipboard
  const paste = await pagePasteHandler(t, () => new Promise(resolve => { resolveClipboard = resolve }))
  const pending = paste()
  assert.equal(typeof resolveClipboard, 'function')
  t.close()
  const fresh = await open(t); const screen = Screen.instances.at(-1)
  const focused = screen.focusCalls
  resolveClipboard('echo OLD_SESSION\r')
  await pending; tick()
  assert.equal(fresh.sent.filter(f => f instanceof Uint8Array).reduce((n, f) => n + f.byteLength, 0), 0)
  assert.equal(screen.focusCalls, focused)
}))

test('late clipboard success/rejection after close or disposal has no input/focus/error side effect', () => fixture(async ({ create, open, tick }) => {
  for (const mode of ['close', 'dispose', 'reopen-reject']) {
    const t = create(); const ws = await open(t); const screen = Screen.instances.at(-1)
    let resolveRead, rejectRead
    const uiError = { value: 'current-message' }
    const paste = await pagePasteHandler(t, () => new Promise((resolve, reject) => { resolveRead = resolve; rejectRead = reject }), uiError)
    const pending = paste(); const focused = screen.focusCalls
    if (mode === 'dispose') t.dispose()
    else t.close()
    if (mode === 'reopen-reject') { await open(t); rejectRead(new Error('permission denied')) }
    else resolveRead('old text')
    await pending; tick()
    assert.equal(ws.sent.filter(f => f instanceof Uint8Array).length, 0)
    assert.equal(screen.focusCalls, focused)
    assert.equal(uiError.value, 'current-message')
  }
}))

test('same-session component clipboard paste still sends UTF-8 and reports permission denial', () => fixture(async ({ create, open, tick }) => {
  const t = create(); const ws = await open(t); const screen = Screen.instances.at(-1)
  const paste = await pagePasteHandler(t, async () => '中文\r')
  await paste(); tick()
  const data = ws.sent.filter(f => f instanceof Uint8Array)
  assert.equal(new TextDecoder().decode(data[0]), '中文\r')
  assert.ok(screen.focusCalls >= 2)
  const uiError = { value: '' }
  const denied = await pagePasteHandler(t, async () => { throw new Error('permission denied') }, uiError)
  await denied()
  assert.equal(uiError.value, 'terminal_clipboard_denied')
}))

test('exit closes transport immediately but drains final output into a retained read-only screen', () => fixture(async ({ create, open, tick, timers }) => {
  for (const code of [0, 7]) {
    const t = create(); const ws = await open(t); const screen = Screen.instances.at(-1)
    ws.message(new TextEncoder().encode('FINAL RESULT\r\n').buffer)
    ws.message({ type: 'exit', code })
    assert.equal(ws.readyState, 3)
    assert.equal(Boolean(screen.disposed), false, 'must not destroy output queued before exit')
    assert.equal(screen.options.disableStdin, true)
    assert.equal(t.sendInput('new input'), false)
    assert.equal(t.status.value, 'exited')
    assert.equal(t.errorCode.value, code === 0 ? '' : 'terminal_process_exit')
    await sleep(1) // Let the separate close HTTP request clear its request timeout.
    assert.ok([...timers.values()].every(timer => timer.delay <= 5000), JSON.stringify([...timers.values()].map(({ delay, origin }) => ({ delay, origin }))))
    screen.callbacks[0].cb(); tick()
    assert.equal(screen.visible, 'FINAL RESULT\r\n')
    assert.equal(Boolean(screen.disposed), false)
    assert.equal(ws.sent.filter(f => f.type === 'ack').length, 0, 'closed socket must not ACK late consumption')
    assert.equal(timers.size, 0, 'consumed readonly output must retain no periodic/drain timers')
    t.dispose()
    assert.equal(screen.disposed, true)
  }
}))

test('renderer drain never exceeds five seconds and falls back to a bounded readonly snapshot', () => fixture(async ({ create, open, timers, tick }) => {
  const t = create(); const ws = await open(t); const screen = Screen.instances.at(-1)
  ws.message(new TextEncoder().encode('visible before blocked tail\n').buffer)
  screen.callbacks[0].cb(); tick()
  ws.message(new Uint8Array(16384).buffer)
  ws.message({ type: 'exit', code: 0 })
  assert.equal(Boolean(screen.disposed), false)
  const drain = [...timers.values()].find(timer => timer.delay > 0 && timer.delay <= 5000)
  assert.ok(drain)
  tick(5000)
  assert.equal(screen.disposed, true)
  assert.match(t.finalOutput.value, /visible before blocked tail/)
  assert.ok(new TextEncoder().encode(t.finalOutput.value).byteLength <= 16384)
  assert.equal(t.errorCode.value, 'terminal_ack_timeout')
  const sent = ws.sent.length
  screen.callbacks[1].cb(); tick(75000)
  assert.equal(ws.sent.length, sent)
  assert.equal(timers.size, 0)
}))

test('reopen/page disposal cancel old renderer drain and stale callbacks cannot change new session', () => fixture(async ({ create, open, tick }) => {
  const t = create(); const old = await open(t); const screen = Screen.instances.at(-1)
  old.message(new TextEncoder().encode('OLD FINAL').buffer); old.message({ type: 'exit', code: 0 })
  const fresh = await open(t); const newScreen = Screen.instances.at(-1)
  assert.equal(screen.disposed, true)
  screen.callbacks[0].cb()
  screen.handlers.data('old parser response')
  screen.handlers.binary('old binary response')
  tick()
  assert.equal(t.status.value, 'running')
  assert.equal(newScreen.visible, '')
  assert.equal(fresh.sent.filter(f => f.type === 'ack').length, 0)
  assert.equal(fresh.sent.filter(f => f instanceof Uint8Array).length, 0)
  fresh.message(new Uint8Array([120]).buffer); fresh.message({ type: 'exit', code: 0 })
  window.dispatchEvent(new Event('pagehide'))
  assert.equal(newScreen.disposed, true)
  newScreen.callbacks[0].cb(); tick(75000)
  assert.equal(fresh.sent.filter(f => f.type === 'ack').length, 0)
}))

test('S1 final output drain cannot retain permission or block S2 keyboard/echo', () => fixture(async ({ create, open, tick }) => {
  const a = create(); const wa = await open(a); const sa = Screen.instances.at(-1)
  const b = create(); const wb = await open(b); const sb = Screen.instances.at(-1)
  wa.message(new TextEncoder().encode('S1 RESULT').buffer); wa.message({ type: 'exit', code: 0 })
  sb.handlers.data('S2'); tick()
  wb.message(new TextEncoder().encode('S2').buffer); sb.callbacks[0].cb(); tick()
  assert.equal(a.status.value, 'exited')
  assert.equal(wa.readyState, 3)
  assert.equal(b.status.value, 'running')
  assert.equal(sb.visible, 'S2')
  sa.callbacks[0].cb(); tick()
  assert.equal(sa.visible, 'S1 RESULT')
  assert.equal(wa.sent.filter(f => f.type === 'ack').length, 0)
  assert.equal(wb.sent.filter(f => f.type === 'ack').at(-1).bytes, 2)
}))

test('repeated close cannot extend the monotonic renderer deadline or its 16KiB snapshot cap', () => fixture(async ({ create, open, tick, timers }) => {
  const t = create(); const ws = await open(t); const screen = Screen.instances.at(-1)
  screen.resize(500, 500)
  const visible = new TextEncoder().encode(('X'.repeat(500) + '\n').repeat(500))
  for (let offset = 0; offset < visible.length; offset += 16384) {
    ws.message(visible.slice(offset, offset + 16384).buffer)
    screen.callbacks.at(-1).cb()
  }
  tick()
  const descriptor = Object.getOwnPropertyDescriptor(performance, 'now')
  let now = 100
  Object.defineProperty(performance, 'now', { configurable: true, value: () => now })
  try {
    ws.message(new Uint8Array([120]).buffer); ws.message({ type: 'exit', code: 0 })
    now = 1100
    t.close()
    await sleep(1)
    const remaining = [...timers.values()]
    assert.equal(remaining.length, 1, JSON.stringify(remaining.map(({ delay, origin }) => ({ delay, origin }))))
    assert.equal(remaining[0].delay, 4000)
    tick(4000)
    assert.equal(new TextEncoder().encode(t.finalOutput.value).byteLength, 16384)
    assert.equal(screen.disposed, true)
    assert.equal(timers.size, 0)
  } finally {
    if (descriptor) Object.defineProperty(performance, 'now', descriptor)
    else delete performance.now
  }
}))

test('renderer theme refresh uses effective CSS colors without reserving, reconnecting or clearing final output', () => fixture(async ({ create, open, calls, timers }) => {
  const t = create(); const ws = await open(t); const screen = Screen.instances.at(-1)
  const id = t.sessionId.value, timerCount = timers.size, callCount = calls.length
  globalThis.getComputedStyle = () => ({ backgroundColor: 'rgb(255, 255, 255)', color: 'rgb(23, 32, 48)' })
  assert.equal(t.refreshTheme(), true)
  assert.deepEqual(screen.options.theme, { background: 'rgb(255, 255, 255)', foreground: 'rgb(23, 32, 48)', cursor: 'rgb(23, 32, 48)' })
  assert.equal(t.sessionId.value, id)
  assert.equal(t.status.value, 'running')
  assert.equal(calls.length, callCount)
  assert.equal(timers.size, timerCount)
  assert.equal(Socket.instances.length, 1)
  ws.message(new TextEncoder().encode('FINAL').buffer); screen.callbacks[0].cb()
  t.close()
  globalThis.getComputedStyle = () => ({ backgroundColor: 'rgb(16, 20, 28)', color: 'rgb(248, 250, 252)' })
  assert.equal(t.refreshTheme(), true)
  assert.equal(screen.options.theme.background, 'rgb(16, 20, 28)')
  assert.equal(screen.visible, 'FINAL')
  t.dispose()
  assert.equal(t.refreshTheme(), false)
}))

test('compiled standalone terminal preserves actual theme, input ownership and bounded workspace', { timeout: 120000 }, () => {
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/terminal-page.mjs'], { encoding: 'utf8', windowsHide: true, timeout: 120000, env: process.env })
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0)
})
