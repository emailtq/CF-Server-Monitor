import assert from 'node:assert/strict'
import en from '../../../src/frontend/locales/en.js'

export async function inputComfortChecks({ page, report, check, output, out, menu, closeMenu, socket, inputCredit }) {
  const toggle = page.locator('[data-terminal-composer-toggle]')
  const draft = page.locator('[data-terminal-composer-input]')
  const mobile = page.locator('.terminal-mobile-input')
  const send = page.locator('[data-terminal-composer-send]')
  const sendReturn = page.locator('[data-terminal-composer-send-return]')
  const cancel = page.locator('[data-terminal-composer-cancel]')
  const waitForInput = async bytes => {
    const deadline = Date.now() + 2000
    while (inputCredit.received() < bytes && Date.now() < deadline) await page.waitForTimeout(20)
    assert.equal(inputCredit.received(), bytes)
  }
  await check('composer submits only on explicit action, normalizes multiline text and preserves rejected drafts', async () => {
    assert.equal(await page.locator('[data-terminal-composer]').count(), 0)
    await output('\x1b[?2004h')
    const prior = report.inputs.join('')
    await page.locator('[data-terminal-composer-toggle]').click()
    assert.equal(await draft.evaluate(el => el === document.activeElement), false)
    await draft.focus()
    await draft.evaluate(el => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      el.value = '中文'
      el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }))
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }))
    })
    assert.equal(await send.isDisabled(), true)
    await draft.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' })))
    assert.equal(await send.isEnabled(), true)
    assert.equal(report.inputs.join(''), prior)
    await draft.fill('echo one\necho two')
    await page.keyboard.press('Shift+Enter')
    assert.equal(report.inputs.join(''), prior)
    assert.equal(await page.locator('.terminal-composer-warning').count(), 1)
    await page.locator('[data-terminal-composer-send]').click()
    await page.waitForTimeout(40)
    assert.equal(report.inputs.join('').slice(prior.length), '\x1b[200~echo one\recho two\r\x1b[201~')
    await page.locator('[data-terminal-composer-toggle]').click()
    await draft.fill('append')
    await page.locator('[data-terminal-composer-send-return]').click()
    await page.waitForTimeout(40)
    assert.equal(report.inputs.join('').slice(prior.length), '\x1b[200~echo one\recho two\r\x1b[201~\x1b[200~append\x1b[201~\r')
    await page.locator('[data-terminal-composer-toggle]').click()
    await page.locator('[data-terminal-composer-input]').fill('x'.repeat(16384))
    const beforeReject = report.inputs.join('')
    await page.locator('[data-terminal-composer-send-return]').click()
    assert.equal(await page.locator('[data-terminal-composer-input]').inputValue(), 'x'.repeat(16384))
    await page.waitForTimeout(40)
    assert.equal(report.inputs.join(''), beforeReject, 'rejected submit must not leak an unadmitted Return')
    await page.locator('[data-terminal-composer-cancel]').click()
  })

  await check('focused composer leaves mobile input and keyboard-focus entry usable at simulated keyboard height', async () => {
    if (report.pointer !== 'coarse') return
    await page.setViewportSize({ width: 390, height: 844 })
    const keys = page.locator('[data-terminal-keys]')
    const focusKeyboard = page.getByRole('button', { name: en.terminalKeyboard, exact: true })
    if (await keys.getAttribute('aria-expanded') !== 'true') await keys.tap()
    await toggle.tap()
    await draft.tap()
    await page.keyboard.insertText('preview\nonly')
    await page.evaluate(() => {
      window.originalVisualViewport = window.visualViewport
      const viewport = new EventTarget()
      viewport.height = 300
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
      window.originalVisualViewport.dispatchEvent(new Event('resize'))
    })
    await page.waitForFunction(() => document.querySelector('.terminal-page').getBoundingClientRect().height === 300)
    assert.equal(await draft.evaluate(el => el === document.activeElement), true)
    const hit = async locator => {
      const box = await locator.evaluate(el => {
        const { x, y, width, height } = el.getBoundingClientRect()
        const target = document.elementFromPoint(x + width / 2, y + height / 2)
        return { x, y, width, height, hit: el.contains(target) }
      })
      assert.ok(box.hit && box.y >= 0 && box.y + box.height <= 300 && box.width >= 44 && box.height >= 44, JSON.stringify(box))
      return box
    }
    const tap = async locator => { const { x, y, width, height } = await hit(locator); await page.touchscreen.tap(x + width / 2, y + height / 2) }
    try {
      for (const locator of [mobile, focusKeyboard, send, sendReturn, cancel]) await hit(locator)
      assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches && document.documentElement.scrollWidth <= 390), true)
      for (const theme of ['light', 'dark']) {
        await page.locator('body').evaluate((el, theme) => el.classList.toggle('light', theme === 'light'), theme)
        await page.screenshot({ path: `${out}/composer-390x300-${theme}-focused.png`, clip: { x: 0, y: 0, width: 390, height: 300 } })
      }
      await tap(focusKeyboard)
      assert.equal(await mobile.evaluate(el => el === document.activeElement), true)
      await tap(draft)
      await tap(mobile)
      assert.equal(await mobile.evaluate(el => el === document.activeElement), true)
      const before = inputCredit.received()
      await page.keyboard.insertText('q')
      await waitForInput(before + 1)
      assert.equal(report.inputs.at(-1), 'q')
      assert.equal(await draft.inputValue(), 'preview\nonly')
      await tap(send)
      await waitForInput(before + 1 + 24)
      assert.equal(report.inputs.at(-1), '\x1b[200~preview\ronly\x1b[201~')
      await tap(toggle)
      await draft.fill('cancel at keyboard height')
      await tap(cancel)
      assert.equal(await draft.count(), 0)
      await waitForInput(before + 1 + 24)
    } finally {
      await page.evaluate(() => { Object.defineProperty(window, 'visualViewport', { configurable: true, value: window.originalVisualViewport }); window.visualViewport.dispatchEvent(new Event('resize')) })
    }
  })

  await check('composer draft clears on replacement and non-running session', async () => {
    await page.locator('[data-terminal-composer-toggle]').click()
    await page.locator('[data-terminal-composer-input]').fill('must not cross session')
    await menu()
    await page.locator('.terminal-session summary').click()
    const sessionBefore = await page.locator('.terminal-session').textContent()
    await page.locator('[data-terminal-disconnect]').click()
    assert.equal(await page.locator('[data-terminal-composer]').count(), 0)
    await menu()
    await page.getByRole('button', { name: en.terminalReopen, exact: true }).click()
    await closeMenu()
    await page.waitForFunction(() => !window.fixtureScreen.options.disableStdin)
    await menu()
    await page.locator('.terminal-session summary').click()
    const sessionAfter = await page.locator('.terminal-session').textContent()
    assert.notEqual(sessionAfter.match(/session-\d+/)?.[0], sessionBefore.match(/session-\d+/)?.[0])
    await closeMenu()
    assert.equal(await page.locator('[data-terminal-composer]').count(), 0)
    await page.locator('[data-terminal-composer-toggle]').click()
    assert.equal(await draft.inputValue(), '')
    await page.locator('[data-terminal-composer-input]').fill('clear on exit')
    socket().send('{"type":"exit","code":0}')
    await page.waitForFunction(() => document.querySelector('[data-terminal-composer]') === null && window.fixtureScreen.options.disableStdin)
    assert.equal(await toggle.isDisabled(), true)
    await menu()
    await page.getByRole('button', { name: en.terminalReopen, exact: true }).click()
    await closeMenu()
    await page.waitForFunction(() => !window.fixtureScreen.options.disableStdin)
    await toggle.click()
    assert.equal(await draft.inputValue(), '')
    await cancel.click()
  })

  await check('added virtual keys use xterm cursor mode and keep old Ctrl/Alt/Esc/Tab/Copy/Paste behavior', async () => {
    if (!(await page.locator('.terminal-key-controls').isVisible())) await page.locator('[data-terminal-keys]').click()
    await output('\x1b[?2004h')
    const before = report.inputs.length
    await output('\x1b[?1l')
    await page.locator('[data-terminal-arrow-up]').click()
    await page.locator('[data-terminal-arrow-down]').click()
    await output('\x1b[?1h')
    await page.locator('[data-terminal-arrow-up]').click()
    await page.locator('[data-terminal-arrow-down]').click()
    await page.getByRole('button', { name: en.terminalBackspace, exact: true }).click()
    await page.getByRole('button', { name: 'Ctrl', exact: true }).click()
    await page.locator('.terminal-mobile-input').fill('c')
    await page.getByRole('button', { name: 'Alt', exact: true }).click()
    await page.locator('.terminal-mobile-input').fill('x')
    await page.getByRole('button', { name: 'Esc', exact: true }).click()
    await page.getByRole('button', { name: 'Tab', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: en.copy, exact: true }).count(), 1)
    assert.equal(await page.getByRole('button', { name: en.terminalPaste, exact: true }).count(), 1)
    await page.waitForTimeout(40)
    assert.equal(report.inputs.slice(before).join(''), '\x1b[A\x1b[B\x1bOA\x1bOB\x7f\x03\x1bx\x1b\t')
    await output('\r\nCOPYME\r\n')
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: window.fixtureClipboard })
      window.clipboardResolve = undefined
      const screen = window.fixtureScreen, buffer = screen.buffer.active
      const row = Array.from({ length: buffer.length }, (_, index) => index).find(index => buffer.getLine(index)?.translateToString(true).includes('COPYME'))
      if (row === undefined) throw new Error('copy test text not rendered')
      screen.select(buffer.getLine(row).translateToString(true).indexOf('COPYME'), row, 6)
    })
    await page.getByRole('button', { name: en.copy, exact: true }).click()
    assert.equal(await page.evaluate(() => window.copied), 'COPYME')
    const pasteAt = report.inputs.length
    await page.getByRole('button', { name: en.terminalPaste, exact: true }).click()
    await page.waitForFunction(() => typeof window.clipboardResolve === 'function')
    await page.evaluate(() => window.clipboardResolve('pasted'))
    await page.waitForTimeout(40)
    assert.equal(report.inputs.slice(pasteAt).join(''), '\x1b[200~pasted\x1b[201~')
  })

  await check('font buttons hold at 10 and 32, reset to 14 and refit actual xterm grid', async () => {
    const before = await page.evaluate(() => ({ cols: window.fixtureScreen.cols, rows: window.fixtureScreen.rows }))
    await menu()
    await page.locator('[data-terminal-font-increase]').click()
    assert.equal(await page.locator('[data-terminal-font-value]').textContent(), '15px')
    const bigger = await page.evaluate(() => ({ cols: window.fixtureScreen.cols, rows: window.fixtureScreen.rows }))
    assert.ok(bigger.cols < before.cols || bigger.rows < before.rows)
    for (let size = 15; size < 32; size++) await page.locator('[data-terminal-font-increase]').click()
    assert.equal(await page.locator('[data-terminal-font-value]').textContent(), '32px')
    assert.equal(await page.evaluate(() => window.fixtureScreen.options.fontSize), 32)
    assert.equal(await page.locator('[data-terminal-font-increase]').isDisabled(), true)
    for (let size = 32; size > 10; size--) await page.locator('[data-terminal-font-decrease]').click()
    assert.equal(await page.locator('[data-terminal-font-value]').textContent(), '10px')
    assert.equal(await page.evaluate(() => window.fixtureScreen.options.fontSize), 10)
    assert.equal(await page.locator('[data-terminal-font-decrease]').isDisabled(), true)
    await page.locator('[data-terminal-font-reset]').click()
    assert.equal(await page.locator('[data-terminal-font-value]').textContent(), '14px')
    assert.equal(await page.evaluate(() => window.fixtureScreen.options.fontSize), 14)
    const after = await page.evaluate(() => ({ cols: window.fixtureScreen.cols, rows: window.fixtureScreen.rows }))
    assert.ok(after.cols > 0 && after.rows > 0)
    const viewports = report.pointer === 'coarse' ? [[390, 300], [390, 844]] : [[1440, 900]]
    for (const [width, height] of viewports) {
      await page.setViewportSize({ width, height })
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => document.body.classList.toggle('light', theme === 'light'), theme)
        await page.waitForTimeout(40)
        await page.locator('[data-terminal-font-reset]').scrollIntoViewIfNeeded()
        const geometry = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, buttons: [...document.querySelectorAll('.terminal-font-size button')].map(el => { const r = el.getBoundingClientRect(); return { width: r.width, height: r.height, top: r.top, bottom: r.bottom } }) }))
        assert.ok(geometry.width <= width, JSON.stringify(geometry))
        assert.ok(geometry.buttons.every(button => button.width >= 44 && button.height >= 44), JSON.stringify(geometry.buttons))
        assert.ok(geometry.buttons.every(button => button.top >= 0 && button.bottom <= height), JSON.stringify(geometry.buttons))
        await page.screenshot({ path: `${out}/terminal-settings-${width}x${height}-${theme}.png` })
      }
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await page.keyboard.press('Escape')
    await closeMenu()
  })

  await check('Send + Enter rejects insufficient peer credit without partial paste and succeeds after ACK', async () => {
    await page.waitForFunction(() => !window.fixtureScreen.options.disableStdin)
    const used = inputCredit.hold()
    // 13 bytes left: the entire bracketed paste fits, but its trailing CR does not.
    const target = 262144 - 13
    try {
      let remaining = target
      while (remaining) {
        const chunkSize = Math.min(16384, remaining)
        await mobile.fill('x'.repeat(chunkSize))
        remaining -= chunkSize
        await waitForInput(used + target - remaining)
      }
      const before = report.inputs.length
      await toggle.click()
      await draft.fill('z')
      await sendReturn.click()
      await page.waitForTimeout(50)
      assert.equal(report.inputs.length, before, 'must not admit even the paste prefix when only the Return would not fit')
      assert.equal(await draft.inputValue(), 'z')
      assert.match(await page.locator('.terminal-notice').innerText(), /wait for terminal acknowledgements/)
      inputCredit.release(used + 1)
      await sendReturn.click()
      await waitForInput(used + target + 14)
      assert.equal(report.inputs.slice(before).join(''), '\x1b[200~z\x1b[201~\r')
      assert.equal(await draft.count(), 0)
      report.composerCredit = { rejectedWithBytesAvailable: 13, partialAckBytes: 1, retryBytes: 14 }
    } finally {
      inputCredit.resume()
    }
  })
}
