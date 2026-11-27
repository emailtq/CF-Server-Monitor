import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { readFile } from 'node:fs/promises'
import { parse, compileScript } from '@vue/compiler-sfc'
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

test('theme REST preserves plain errors and rejects proxy HTML, accepts 204 and uploads ordered octet chunks', async t => {
  const vite = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  t.after(() => vite.close())
  const previous = { window: globalThis.window, localStorage: globalThis.localStorage, fetch: globalThis.fetch }
  t.after(() => Object.assign(globalThis, previous))
  globalThis.window = { location: { origin: 'https://test.example' }, __APP_API_BASES__: ['https://test.example', 'https://other.example'] }
  globalThis.localStorage = { getItem: () => '', removeItem() {}, setItem() {} }
  const api = await vite.ssrLoadModule('/src/frontend/utils/api.js')
  assert.equal(typeof api.monitorThemeApi, 'function')
  globalThis.fetch = async () => new Response('Actual upstream failure', { status: 503, headers: { 'Content-Type': 'text/plain' } })
  const failure = await api.monitorThemeApi('GET', '/themes')
  assert.equal(failure.error, 'Actual upstream failure')
  assert.equal(failure.status, 503)
  globalThis.fetch = async () => new Response('<html>proxy</html>', { headers: { 'Content-Type': 'text/html' } })
  assert.equal((await api.monitorThemeApi('GET', '/themes')).error, 'monitorThemeInvalidResponse')
  globalThis.fetch = async () => new Response(null, { status: 204 })
  assert.equal((await api.monitorThemeApi('PUT', '/themes/default/config', {})).status, 204)
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return Response.json(calls.length === 1 ? { received: 4194304 } : { theme: { short: 'original', version: '1.0' } })
  }
  const result = await api.uploadMonitorThemeRest(new Blob([new Uint8Array(4194305)]), 1, () => true)
  assert.equal(result.data.theme.short, 'original')
  assert.deepEqual(calls.map(c => c.url), ['https://other.example/api/themes?offset=0&total=4194305', 'https://other.example/api/themes?offset=4194304&total=4194305'])
  assert.deepEqual(calls.map(c => c.init.body.size), [4194304, 1])
  assert.ok(calls.every(c => c.init.headers['Content-Type'] === 'application/octet-stream'))
  calls.length = 0
  const stale = await api.uploadMonitorThemeRest(new Blob(['x']), 0, () => false)
  assert.equal(stale.stale, true)
  assert.equal(calls.length, 0)
})

test('manager opens configuration from fresh REST overrides, not stale list config', async t => {
  const source = await readFile('src/frontend/views/admin/components/MonitorThemeManager.vue', 'utf8')
  const script = compileScript(parse(source).descriptor, { id: 'fresh-config' }).content
  const bundled = await build({ stdin: { contents: script, resolveDir: new URL('../src/frontend/views/admin/components/', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1') }, plugins: [{ name: 'components', setup(b) { b.onResolve({ filter: /\.vue$/ }, a => ({ path: a.path, namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default {}' })) } }], bundle: true, write: false, format: 'esm', platform: 'node', external: ['vue'] })
  const dir = await mkdtemp(join(tmpdir(), 'cfsm-theme-front-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'manager.mjs')
  await writeFile(path, bundled.outputFiles[0].text.replaceAll('from "vue"', `from ${JSON.stringify(import.meta.resolve('vue'))}`))
  const component = (await import(pathToFileURL(path))).default
  const previous = { window: globalThis.window, localStorage: globalThis.localStorage, fetch: globalThis.fetch }
  globalThis.window = { location: { origin: 'https://test.example' } }
  globalThis.localStorage = { getItem: () => '', removeItem() {}, setItem() {} }
  const urls = []
  globalThis.fetch = async url => { urls.push(url); return Response.json({ show_summary: false, unknown: 'preserve' }) }
  try {
    const manager = component.setup({ trans: { monitorThemeSaved: 'Saved {theme} {version}' }, activeTab: '', selectedApiIndex: 0 }, { expose() {}, emit() {} })
    manager.state.value = { themes: [], configs: { default: { show_summary: true } } }
    await manager.configure({ short: 'default', config: [{ key: 'show_summary', type: 'boolean', default: true }] })
    assert.deepEqual(urls, ['https://test.example/api/themes/default/config'])
    assert.equal(manager.draft.value.show_summary, false)
    assert.equal(manager.configBase.value.unknown, 'preserve')
    manager.draft.value.show_summary = true
    globalThis.fetch = async () => new Response('D1 save failed', { status: 503, headers: { 'Content-Type': 'text/plain' } })
    await manager.saveConfig()
    assert.equal(manager.editing.value.short, 'default')
    assert.equal(manager.notice.value.type, 'error')
    assert.match(manager.notice.value.text, /default.*D1 save failed/)
    let stored
    globalThis.fetch = async (url, init) => { stored = JSON.parse(init.body); return new Response(null, { status: 204 }) }
    await manager.saveConfig()
    assert.equal(manager.editing.value, null)
    assert.deepEqual(stored, { unknown: 'preserve' })
    globalThis.fetch = async () => Response.json({ show_summary: false, unknown: 'preserve' })
    await manager.configure({ short: 'default', config: [{ key: 'show_summary', type: 'boolean', default: true }] })
    manager.resetConfig()
    assert.equal(manager.draft.value.show_summary, true)
    assert.deepEqual(manager.configBase.value, {})
    manager.iconSaved.value = { favicon: 'saved', touch_icon: '' }
    manager.iconDraft.value = { favicon: 'unsaved choice', touch_icon: '' }
    globalThis.fetch = async url => Response.json(url.endsWith('/api/settings')
      ? { favicon: 'fresh', touch_icon: '' }
      : { themes: [] })
    await manager.load()
    assert.equal(manager.iconSaved.value.favicon, 'fresh')
    assert.equal(manager.iconDraft.value.favicon, 'unsaved choice')
    manager.iconDraft.value = { ...manager.iconSaved.value }
    globalThis.fetch = async url => Response.json(url.endsWith('/api/settings')
      ? { favicon: 'next saved', touch_icon: '' }
      : { themes: [] })
    await manager.load()
    assert.equal(manager.iconDraft.value.favicon, 'next saved')
    const previousImage = globalThis.Image, previousReader = globalThis.FileReader, previousDocument = globalThis.document
    let canvasSide, filled
    globalThis.FileReader = class { readAsDataURL() { this.result = 'data:image/png;base64,AAAA'; this.onload() } }
    globalThis.Image = class { naturalWidth = 360; naturalHeight = 180; async decode() {} }
    globalThis.document = { createElement() { return { set width(value) { canvasSide = value }, get width() { return canvasSide }, getContext() { return { fillRect() { filled = true }, drawImage() {} } }, toDataURL() { return 'data:image/png;base64,AAAA' } } } }
    try {
      await manager.iconFile('touch_icon', { target: { files: [{ type: 'image/png', size: 22872 }], value: 'picked' } })
      assert.equal(canvasSide, 180)
      assert.equal(filled, true)
      assert.equal(manager.iconDraft.value.touch_icon, 'data:image/png;base64,AAAA')
    } finally { globalThis.Image = previousImage; globalThis.FileReader = previousReader; globalThis.document = previousDocument }
  } finally { Object.assign(globalThis, previous) }
})
