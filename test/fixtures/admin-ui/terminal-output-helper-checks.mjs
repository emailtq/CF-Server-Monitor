import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

export async function outputHelperChecks({ page, context, report, check, output, out, menu, closeMenu, socket, exports }) {
  page.setDefaultTimeout(4000)
  const query = page.locator('[data-terminal-search-input]')
  const openSearch = async () => { if (!await query.count()) await page.locator('[data-terminal-search]').click() }
  const selection = () => page.evaluate(() => ({ text: window.fixtureScreen.getSelection(), position: window.fixtureScreen.getSelectionPosition() }))
  const reset = async text => {
    await dismissLink()
    await output('\x1b[?1049l\x1b[?1000l\x1b[?1006l\x1b[2J\x1b[3J\x1b[H' + text)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }
  const point = async (row = 0, col = 2) => page.locator('.xterm-screen').evaluate((el, { row, col }) => {
    const box = el.getBoundingClientRect(), s = window.fixtureScreen
    return { x: box.x + (col + .5) * box.width / s.cols, y: box.y + (row + .5) * box.height / s.rows }
  }, { row, col })
  const activate = async (row = 0, col = 2) => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const p = await point(row, col)
    const away = await point(row + 3, col)
    await page.mouse.move(away.x, away.y)
    await page.mouse.move(p.x, p.y)
    await page.mouse.click(p.x, p.y)
  }
  const dismissLink = async () => { if (await page.locator('[data-terminal-link-target]').count()) await page.keyboard.press('Escape') }
  await check('literal search owns only local input and navigates repeated CJK and soft wraps', async () => {
    assert.equal(await query.count(), 0)
    const cols = await page.evaluate(() => window.fixtureScreen.cols)
    await reset('中文 alpha.* first\r\nalpha.* second\r\n' + 'x'.repeat(cols - 3) + '跨行中文 token\r\n')
    const prior = report.inputs.join('')
    await openSearch()
    assert.equal(await query.evaluate(el => el === document.activeElement), true)
    await query.fill('alpha.*')
    assert.equal((await selection()).text, 'alpha.*')
    const first = (await selection()).position
    await query.press('Enter')
    const second = (await selection()).position
    assert.notDeepEqual(second, first)
    await query.press('Shift+Enter')
    assert.deepEqual((await selection()).position, first)
    await query.fill('跨行中文')
    assert.equal((await selection()).text, '跨行中文')
    assert.ok((await selection()).position.end.y > (await selection()).position.start.y, 'CJK match crosses a real soft wrap')
    await query.fill('firstalpha')
    assert.equal(await page.locator('[data-terminal-search-empty]').isVisible(), true)
    await query.fill('not-retained')
    assert.equal(await page.locator('[data-terminal-search-empty]').isVisible(), true)
    await query.fill('')
    assert.equal(await page.locator('.xterm-find-result-decoration').count(), 0)
    await query.press('Escape')
    assert.equal(await query.count(), 0)
    await page.waitForTimeout(40)
    assert.equal(report.inputs.join(''), prior)
    assert.equal(await page.locator('.xterm-helper-textarea').evaluate(el => el === document.activeElement), true)
    await page.keyboard.press('Control+f')
    await page.waitForTimeout(40)
    assert.equal(await query.count(), 0, 'there is no global Ctrl+F search binding')
    assert.equal(report.inputs.join('').slice(prior.length), '\x06', 'remote Ctrl+F remains an xterm key')
  })
  await check('active-buffer search refreshes on output/alternate screens and preserves a later manual selection on close', async () => {
    await reset('normal needle\r\nmanual selection\r\n')
    await openSearch()
    await query.fill('needle')
    await output('\r\nappended needle\r\n')
    await page.waitForTimeout(250)
    assert.equal((await selection()).text, 'needle')
    await output('\x1b[?1049hALT ONLY needle')
    await page.waitForTimeout(250)
    assert.equal((await selection()).text, 'needle')
    await query.fill('normal')
    assert.equal(await page.locator('[data-terminal-search-empty]').isVisible(), true)
    await output('\x1b[?1049l')
    await page.waitForTimeout(250)
    assert.equal((await selection()).text, 'normal')
    await page.evaluate(() => window.fixtureScreen.select(0, 1, 6))
    const manual = await selection()
    await page.locator('[data-terminal-search-close]').click()
    await page.waitForTimeout(250)
    assert.deepEqual(await selection(), manual)
    assert.equal(await page.locator('.xterm-find-result-decoration').count(), 0)
    await page.evaluate(() => window.fixtureScreen.clearSelection())
  })
  await check('current-screen export downloads parsed wide cells with viewport scope and object URL cleanup', async () => {
    await reset('NOT ON SCREEN\r\n' + '\r\n'.repeat(65) + '\x1b[31m可见 screen\x1b[0m\r\nsecond line')
    await page.evaluate(() => {
      window.fixtureUrls = { created: [], revoked: [] }
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL)
      URL.createObjectURL = blob => { const url = create(blob); window.fixtureUrls.created.push({ url, type: blob.type, size: blob.size }); return url }
      URL.revokeObjectURL = url => { window.fixtureUrls.revoked.push(url); revoke(url) }
    })
    const actions = report.actions.length, inputs = report.inputs.join('')
    await menu()
    assert.equal(await page.locator('[data-terminal-export]').count(), 1, 'current-screen export entry is available')
    const wait = page.waitForEvent('download')
    await page.locator('[data-terminal-export]').click()
    const download = await wait
    assert.match(download.suggestedFilename(), /^terminal-current-screen-\d{4}-.*\.txt$/)
    const file = path.join(out, 'screen-download.txt')
    await download.saveAs(file)
    const content = fs.readFileSync(file, 'utf8')
    assert.ok(content.includes('可见 screen') && content.includes('\n') && content.includes('second line'))
    assert.ok(!content.includes('\x1b') && !content.includes('NOT ON SCREEN'))
    await page.waitForFunction(() => window.fixtureUrls.revoked.length === 1)
    const urls = await page.evaluate(() => window.fixtureUrls)
    assert.equal(urls.created[0].type, 'text/plain;charset=utf-8')
    assert.deepEqual(urls.revoked, [urls.created[0].url])
    assert.equal(report.actions.length, actions)
    assert.equal(report.inputs.join(''), inputs)
    await closeMenu()
  })
  await check('empty/failed exports never report success; large parsed screens are bounded at 16 KiB without splitting UTF-8', async () => {
    await reset('')
    await menu()
    await page.locator('[data-terminal-export]').click()
    assert.ok((await page.locator('.terminal-export [role=status]').textContent()).includes('empty'))
    await closeMenu()
    const size = await page.evaluate(() => { const s = window.fixtureScreen, size = [s.cols, s.rows]; s.resize(500, 30); return size })
    await reset(('界'.repeat(250) + '\r\n').repeat(29))
    await menu()
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-terminal-export]').click()])
    const file = path.join(out, 'bounded-screen.txt')
    await download.saveAs(file)
    const data = fs.readFileSync(file)
    assert.ok(data.length <= 16384 && data.length >= 16381, String(data.length))
    assert.ok(data.toString('utf8').includes('界') && !data.toString('utf8').includes('\ufffd'))
    await page.evaluate(() => { window.fixtureAnchorClick = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { throw new Error('browser download failure') } })
    try {
      await page.locator('[data-terminal-export]').click()
      assert.ok((await page.locator('.terminal-export [role=status]').textContent()).includes('failed'))
      await page.waitForFunction(() => window.fixtureUrls.revoked.length === window.fixtureUrls.created.length)
    } finally { await page.evaluate(size => { HTMLAnchorElement.prototype.click = window.fixtureAnchorClick; window.fixtureScreen.resize(...size) }, size) }
    await closeMenu()
  })
  await check('terminal web-link activation requests confirmation and never opens on hover', async () => {
    await closeMenu()
    await reset('https://example.com/real\r\n')
    const box = await page.locator('.xterm-screen').boundingBox()
    await page.mouse.move(box.x + 24, box.y + 9)
    assert.equal(await page.locator('[data-terminal-link-target]').count(), 0)
    await page.mouse.click(box.x + 24, box.y + 9)
    await page.locator('[data-terminal-link-target]').waitFor()
    assert.equal(await page.locator('[data-terminal-link-target]').textContent(), 'https://example.com/real')
    assert.equal(context.pages().length, 1)
    await page.keyboard.press('Escape')
    assert.equal(await page.locator('[data-terminal-link-target]').count(), 0)
  })
  await check('actual detected HTTP/wrapped URLs and misleading OSC8 labels share explicit normalized destination/copy/open policy', async () => {
    await page.evaluate(() => { window.fixtureOpened = []; window.fixtureOriginalOpen = window.open; window.open = (...args) => { window.fixtureOpened.push(args); return null } })
    const inputs = report.inputs.join(''), actions = report.actions.length, sockets = report.sockets
    for (const { text, target, col = 2 } of [
      { text: 'http://example.com/a', target: 'http://example.com/a' },
      { text: 'https://example.com/' + 'w'.repeat(70), target: 'https://example.com/' + 'w'.repeat(70) },
      { text: '\x1b]8;;https://EXAMPLE.com/real-target\x1b\\https://trusted-label.invalid\x1b]8;;\x1b\\', target: 'https://example.com/real-target' }
    ]) {
      await reset(text + '\r\n')
      await activate(0, col)
      await page.locator('[data-terminal-link-target]').waitFor()
      assert.equal(await page.locator('[data-terminal-link-target]').textContent(), target)
      await page.locator('[data-terminal-link-copy]').click()
      await page.waitForFunction(target => window.copied === target, target)
      assert.equal(await page.locator('[data-terminal-link-target]').count(), 0)
      assert.deepEqual(await page.evaluate(() => window.fixtureOpened), [])
    }
    await reset('https://example.com/cancel\r\n')
    await activate()
    await page.locator('[data-terminal-link-cancel]').click()
    assert.equal(await page.evaluate(() => window.fixtureOpened.length), 0)
    await page.evaluate(() => {
      window.fixtureNativeOpens = []
      window.open = (...args) => {
        const tab = window.fixtureOriginalOpen(...args)
        window.fixtureNativeOpens.push({ args, returnedNull: tab === null })
        return tab
      }
    })
    await reset('https://example.com/explicit\r\n')
    await activate()
    await context.route('https://example.com/explicit', route => route.fulfill({ contentType: 'text/html', body: '<title>Synthetic external destination</title>' }))
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('[data-terminal-link-open]').click()])
    await popup.waitForURL('https://example.com/explicit')
    await popup.waitForLoadState()
    assert.equal(popup.url(), 'https://example.com/explicit')
    assert.deepEqual(await popup.evaluate(() => ({ noOpener: window.opener === null, referrer: document.referrer })), { noOpener: true, referrer: '' })
    report.nativeOpens = await page.evaluate(() => window.fixtureNativeOpens)
    assert.equal(await page.locator('.terminal-notice code').count(), 0, 'a genuine popup must not produce a failure notice')
    await popup.close()
    await context.unroute('https://example.com/explicit')
    assert.equal(report.inputs.join(''), inputs)
    assert.equal(report.actions.length, actions)
    assert.equal(report.sockets, sockets)
  })
  await check('external open/copy failures return focus to the same terminal without creating a new session', async () => {
    const sockets = report.sockets, actions = report.actions.length
    await reset('https://example.com/failure\r\n')
    await activate()
    await page.evaluate(() => { window.open = () => { throw new Error('blocked external open') } })
    await page.locator('[data-terminal-link-open]').click()
    await page.waitForFunction(() => document.activeElement === document.querySelector('.xterm-helper-textarea'))
    assert.equal(await page.locator('[data-terminal-link-target]').count(), 0)
    assert.equal(await page.locator('.terminal-notice code').textContent(), 'terminal_link_failed')
    await page.evaluate(() => { window.open = window.fixtureOriginalOpen; window.fixtureWrite = navigator.clipboard.writeText; navigator.clipboard.writeText = async () => { throw new Error('clipboard denied') } })
    await activate()
    await page.locator('[data-terminal-link-copy]').click()
    await page.waitForFunction(() => document.activeElement === document.querySelector('.xterm-helper-textarea'))
    assert.equal(await page.locator('[data-terminal-link-target]').count(), 0)
    await page.evaluate(() => { navigator.clipboard.writeText = window.fixtureWrite })
    assert.equal(report.sockets, sockets)
    assert.equal(report.actions.length, actions)
    await page.locator('[data-terminal-notice-close]').click()
  })
  await check('unsafe schemes, embedded credentials and invalid OSC8 destinations cannot bypass the shared link gate', async () => {
    for (const target of ['javascript:alert(1)', 'data:text/html,bad', 'file:///etc/passwd', 'ssh://example.com', 'https://user:password@example.com/private', 'http://user@example.com/', 'https://[invalid', 'https://example.com/\u202eevil']) {
      await reset(`\x1b]8;;${target}\x1b\\https://safe-label.invalid\x1b]8;;\x1b\\\r\n`)
      await activate()
      assert.equal(await page.locator('[data-terminal-link-target]').count(), 0, target)
    }
    await reset('https://user:password@example.com/private\r\n')
    await activate()
    assert.equal(await page.locator('[data-terminal-link-target]').count(), 0)
  })
  await check('selection gestures, touch long-press/scroll and application mouse reporting never trigger link confirmation', async () => {
    await reset('https://example.com/touch\r\n')
    let p = await point()
    await page.mouse.move(p.x, p.y)
    await page.mouse.down()
    await page.waitForTimeout(450)
    await page.mouse.up()
    assert.equal(await page.locator('[data-terminal-link-target]').count(), 0)
    await page.mouse.move(p.x, p.y)
    await page.mouse.down()
    await page.mouse.move(p.x + 60, p.y)
    await page.mouse.up()
    assert.equal(await page.locator('[data-terminal-link-target]').count(), 0)
    if (report.pointer === 'coarse') {
      await page.evaluate(() => window.fixtureScreen.clearSelection())
      const cdp = await context.newCDPSession(page)
      for (const scrolling of [false, true]) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...p, id: 1 }] })
        if (scrolling) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x, y: p.y + 40, id: 1 }] })
        else await page.waitForTimeout(450)
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        assert.equal(await page.locator('[data-terminal-link-target]').count(), 0)
      }
      // A deliberate tap is distinct from the selection gestures above.
      await reset('https://example.com/touch\r\n')
      await page.evaluate(() => { window.fixtureScreen.clearSelection(); window.getSelection()?.removeAllRanges() })
      const away = await point(3)
      await page.mouse.move(away.x, away.y)
      await page.touchscreen.tap(p.x, p.y)
      await page.locator('[data-terminal-link-target]').waitFor()
      await dismissLink()
    }
    await page.evaluate(() => window.fixtureScreen.clearSelection())
    await output('\x1b[?1000h\x1b[?1006h')
    const before = report.inputs.join('')
    await activate()
    await page.waitForTimeout(40)
    assert.equal(await page.locator('[data-terminal-link-target]').count(), 0)
    assert.match(report.inputs.join('').slice(before.length), /\x1b\[</, 'mouse reporting reaches the synthetic PTY')
    await output('\x1b[?1000l\x1b[?1006l')
  })
  await check('search and export stay available for retained read-only output; reopening clears search ownership', async () => {
    await reset('retained readonly output\r\n')
    socket().send('{"type":"exit","code":0}')
    await page.waitForFunction(() => window.fixtureScreen.options.disableStdin)
    const prior = report.inputs.join('')
    await openSearch()
    await query.fill('readonly')
    assert.equal((await selection()).text, 'readonly')
    await menu()
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-terminal-export]').click()])
    await download.saveAs(path.join(out, 'readonly-screen.txt'))
    assert.ok(fs.readFileSync(path.join(out, 'readonly-screen.txt'), 'utf8').includes('readonly'))
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click()
    await page.waitForFunction(() => !window.fixtureScreen.options.disableStdin)
    assert.equal(await query.count(), 0)
    await openSearch()
    assert.equal(await query.inputValue(), '')
    assert.equal(await page.locator('.xterm-find-result-decoration').count(), 0)
    assert.equal(report.inputs.join(''), prior)
    await query.press('Escape')
  })
  await check('new output controls keep 44px targets and the accepted immediate-input/composer at phone and desktop sizes', async () => {
    for (const [width, height] of report.pointer === 'coarse' ? [[390, 844], [390, 300]] : [[1440, 900]]) {
      await page.setViewportSize({ width, height })
      for (const theme of ['light', 'dark']) {
        await page.evaluate(async ({ file, theme }) => (await import(file)).useTheme().setTheme(theme), { file: exports['/src/frontend/composables/useTheme.js'], theme })
        await reset('current screen\r\nhttps://example.com/verify\r\n中文 output\r\n')
        await openSearch()
        await query.fill('output')
        await page.locator('[data-terminal-composer-toggle]').click()
        await page.locator('[data-terminal-composer-input]').fill('local draft')
        const geometry = await page.evaluate(() => ({
          width: document.documentElement.scrollWidth,
          controls: [...document.querySelectorAll('.terminal-search input,.terminal-search button,.terminal-input-row input,.terminal-input-row button')].map(el => { const r = el.getBoundingClientRect(); return { width: r.width, height: r.height, bottom: r.bottom } }),
          screen: document.querySelector('.terminal-screen').getBoundingClientRect().height
        }))
        assert.ok(geometry.width <= width && geometry.screen > 0, JSON.stringify(geometry))
        for (const rect of geometry.controls) assert.ok(rect.width >= 44 && rect.height >= 44 && rect.bottom <= height, JSON.stringify(rect))
        await page.screenshot({ path: path.join(out, `${report.pointer}-${width}x${height}-${theme}-search-composer.png`) })
        await page.locator('[data-terminal-composer-cancel]').click()
        await query.press('Escape')
        await menu()
        await page.locator('[data-terminal-export]').scrollIntoViewIfNeeded()
        await page.screenshot({ path: path.join(out, `${report.pointer}-${width}x${height}-${theme}-export.png`) })
        await closeMenu()
        await activate(1)
        await page.locator('[data-terminal-link-target]').waitFor()
        await page.screenshot({ path: path.join(out, `${report.pointer}-${width}x${height}-${theme}-link.png`) })
        await dismissLink()
      }
    }
  })
  await check('all seven catalogs render the output tools without losing input or overflowing their dialog', async () => {
    const width = report.pointer === 'coarse' ? 390 : 1440, height = report.pointer === 'coarse' ? 300 : 900
    await page.setViewportSize({ width, height })
    if (await page.locator('[data-terminal-composer-input]').count()) await page.locator('[data-terminal-composer-cancel]').click()
    for (const locale of ['zh', 'zh-TW', 'en', 'es', 'fr', 'id', 'ja']) {
      await page.evaluate(async ({ file, locale }) => (await import(file)).setLanguage(locale), { file: exports['/src/frontend/utils/i18n.js'], locale })
      await reset('current screen\r\nhttps://example.com/verify\r\n中文 output\r\n')
      await openSearch()
      await query.fill('output')
      await page.locator('[data-terminal-composer-toggle]').click()
      await page.locator('[data-terminal-composer-input]').fill('local draft')
      const geometry = await page.evaluate(() => ({
        screen: document.querySelector('.terminal-screen').getBoundingClientRect().height,
        rowHeight: document.querySelector('.xterm-screen').getBoundingClientRect().height / window.fixtureScreen.rows,
        width: document.documentElement.scrollWidth,
        input: document.querySelector('.terminal-mobile-input').getBoundingClientRect().toJSON(),
        keyboard: document.querySelector('.terminal-input-row > button:last-child').getBoundingClientRect().toJSON()
      }))
      assert.ok(geometry.screen >= geometry.rowHeight + 8 && geometry.width <= width, `${locale}: ${JSON.stringify(geometry)}`)
      for (const rect of [geometry.input, geometry.keyboard]) assert.ok(rect.width >= 44 && rect.height >= 44 && rect.bottom <= height, `${locale}: ${JSON.stringify(rect)}`)
      await page.screenshot({ path: path.join(out, `${report.pointer}-${locale}-search-composer.png`) })
      await page.locator('[data-terminal-composer-cancel]').click()
      await query.press('Escape')
      await activate(1)
      await page.locator('[data-terminal-link-target]').waitFor()
      assert.equal(await page.locator('[data-terminal-link-target]').textContent(), 'https://example.com/verify')
      const bounds = await page.getByRole('dialog').boundingBox()
      assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= height)
      await page.screenshot({ path: path.join(out, `${report.pointer}-${locale}-link.png`) })
      await dismissLink()
      await menu()
      await page.locator('[data-terminal-export]').scrollIntoViewIfNeeded()
      await page.screenshot({ path: path.join(out, `${report.pointer}-${locale}-export.png`) })
      await closeMenu()
    }
  })
}
