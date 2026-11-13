import { ref } from 'vue'
import { adminApi, getTerminalBase, getTerminalSocketUrl } from '../utils/api.js'
import { copyTextToClipboard } from '../utils/clipboard.js'
import { TERMINAL_LIMITS, parseTerminalControl, validateTerminalSize, validateTerminalDataFrame } from '../../shared/terminalProtocol.js'

const BATCH_MS = 16
const TRANSPORT_BYTES = 65536
const RENDER_DRAIN_MS = 5000
const FINAL_SNAPSHOT_BYTES = 16384
const encoder = new TextEncoder()

// Count before encoding: a paste must not allocate a second, unbounded UTF-8 copy.
function inputBytes(text, limit) {
  if (typeof text !== 'string' || text.length > limit) return limit + 1
  let bytes = 0
  for (const char of text) {
    const code = char.codePointAt(0)
    bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4
    if (bytes > limit) break
  }
  return bytes
}

export function useTerminal({ serverId, apiIndex = 0 }) {
  const status = ref('idle')
  const errorCode = ref('')
  const sessionId = ref('')
  const finalOutput = ref('')
  const readingHistory = ref(false)
  let epoch = 0
  let renderEpoch = 0
  let drainUntil = 0
  let disposed = false
  let ws = null
  let screen = null
  let fit = null
  let observer = null
  let host = null
  let input = null
  let pendingInput = 0
  let sentInput = 0
  let ackedInput = 0
  let receivedOutput = 0
  let consumedOutput = 0
  let ackedOutput = 0
  let bufferSince = 0
  let lastMessage = 0
  let channel = null
  let historyDispose = null
  const timers = new Map()
  const subscriptions = []

  const cancelTimer = name => {
    if (timers.has(name)) clearTimeout(timers.get(name))
    timers.delete(name)
  }
  const later = (name, callback, delay) => {
    cancelTimer(name)
    const current = epoch
    timers.set(name, setTimeout(() => {
      timers.delete(name)
      if (current === epoch && !disposed) callback()
    }, delay))
  }
  const request = async (action, data = {}) => {
    const result = await adminApi({ action, serverId, ...data }, apiIndex)
    if (result.error) throw new Error(/^terminal_[a-z0-9_]+$/.test(result.error) ? result.error : 'terminal_request_failed')
    return result.data
  }
  const notifyClose = id => {
    if (id) void request('terminal_close', { sessionId: id }).catch(() => {})
  }

  const destroyRenderer = () => {
    renderEpoch++
    drainUntil = 0
    cancelTimer('drain')
    observer?.disconnect()
    observer = null
    historyDispose?.()
    historyDispose = null
    readingHistory.value = false
    host?.removeEventListener('paste', onPaste, true)
    host = null
    screen?.dispose()
    screen = null
    fit = null
    finalOutput.value = ''
  }
  // Only already-parsed visible cells survive a blocked renderer; no terminal-byte replay.
  const snapshotRenderer = () => {
    const bytes = new Uint8Array(FINAL_SNAPSHOT_BYTES)
    const buffer = screen.buffer.active
    const reuse = buffer.getNullCell?.()
    let written = 0
    for (let row = 0; row < Math.min(screen.rows, 500) && written < bytes.length; row++) {
      const line = buffer.getLine(buffer.viewportY + row)
      if (!line) continue
      for (let col = 0; col < Math.min(screen.cols, 500) && written < bytes.length; col++) {
        const cell = line.getCell(col, reuse)
        if (cell?.getWidth?.() === 0) continue
        const chars = cell?.getChars() || ' '
        const encoded = encoder.encodeInto(chars, bytes.subarray(written))
        written += encoded.written
        if (encoded.read !== chars.length) return new TextDecoder().decode(bytes.subarray(0, written))
      }
      if (written < bytes.length) bytes[written++] = 10
    }
    return new TextDecoder().decode(bytes.subarray(0, written))
  }
  const stop = (nextStatus = 'disconnected', reason = '', notify = true, keepScreen = false) => {
    epoch++
    for (const name of [...timers.keys()]) cancelTimer(name)
    host?.removeEventListener('paste', onPaste, true)
    for (const subscription of subscriptions.splice(0)) subscription.dispose()
    const socket = ws
    ws = null
    try { socket?.close(1000, 'terminal closed') } catch (_) {}
    input = null
    pendingInput = 0
    const id = sessionId.value
    sessionId.value = ''
    status.value = nextStatus
    errorCode.value = reason
    if (notify) notifyClose(id)
    if (!keepScreen || !screen) { destroyRenderer(); return }
    screen.options.disableStdin = true
    screen.options.cursorBlink = false
    if (receivedOutput > consumedOutput) {
      if (!drainUntil) drainUntil = performance.now() + RENDER_DRAIN_MS
      later('drain', () => {
        if (receivedOutput <= consumedOutput) return
        let snapshot = ''
        try { snapshot = snapshotRenderer() } catch (_) {}
        destroyRenderer()
        finalOutput.value = snapshot
        errorCode.value = 'terminal_ack_timeout'
      }, Math.max(0, drainUntil - performance.now()))
    }
  }
  const fail = reason => stop('disconnected', reason, true, true)

  const control = frame => {
    if (!ws || ws.readyState !== 1) return false
    const text = JSON.stringify(frame)
    if (encoder.encode(text).byteLength > TERMINAL_LIMITS.controlFrameBytes || ws.bufferedAmount > TRANSPORT_BYTES) {
      fail('terminal_transport_stalled')
      return false
    }
    try { ws.send(text); return true } catch (_) { fail('terminal_disconnected'); return false }
  }

  const inputStall = () => {
    cancelTimer('inputStall')
    if (sentInput > ackedInput) later('inputStall', () => fail('terminal_ack_timeout'), TERMINAL_LIMITS.ackTimeoutMs)
  }
  const outputStall = () => {
    cancelTimer('outputStall')
    if (receivedOutput > consumedOutput) later('outputStall', () => fail('terminal_ack_timeout'), TERMINAL_LIMITS.ackTimeoutMs)
  }
  const flushInput = () => {
    if (!ws || ws.readyState !== 1 || status.value !== 'running' || !pendingInput) return
    if (ws.bufferedAmount > TRANSPORT_BYTES) {
      if (!bufferSince) bufferSince = Date.now()
      if (Date.now() - bufferSince >= 8000) { fail('terminal_transport_stalled'); return }
      later('input', flushInput, BATCH_MS)
      return
    }
    bufferSince = 0
    const size = Math.min(pendingInput, TERMINAL_LIMITS.creditBytes - (sentInput - ackedInput))
    if (size <= 0) return
    try {
      ws.send(input.slice(0, size))
      const wasIdle = sentInput === ackedInput
      sentInput += size
      input.copyWithin(0, size, pendingInput)
      pendingInput -= size
      if (wasIdle) inputStall()
      if (pendingInput) later('input', flushInput, BATCH_MS)
    } catch (_) { fail('terminal_disconnected') }
  }
  const sendInput = (text, binary = false) => {
    if (status.value !== 'running' || !input) return false
    const size = binary ? text.length : inputBytes(text, input.length - pendingInput)
    if (size > input.length - pendingInput) {
      errorCode.value = 'terminal_input_overflow'
      return false
    }
    if (binary) {
      for (let i = 0; i < size; i++) input[pendingInput + i] = text.charCodeAt(i) & 255
    } else {
      encoder.encodeInto(text, input.subarray(pendingInput))
    }
    pendingInput += size
    if (!timers.has('input')) later('input', flushInput, BATCH_MS)
    return true
  }
  const flushAck = () => {
    if (consumedOutput <= ackedOutput) return
    if (control({ type: 'ack', bytes: consumedOutput })) ackedOutput = consumedOutput
  }
  const resize = (cols, rows) => {
    if (!validateTerminalSize(cols, rows)) return false
    if (status.value === 'running') return control({ type: 'resize', cols, rows })
    return false
  }
  const fitScreen = () => {
    const size = fit?.proposeDimensions()
    if (!size) return
    const cols = Math.max(1, Math.min(500, size.cols))
    const rows = Math.max(1, Math.min(500, size.rows))
    if (screen.cols === cols && screen.rows === rows) return
    screen.resize(cols, rows)
  }
  const refreshTheme = () => {
    if (!screen || !host || disposed) return false
    const style = getComputedStyle(host)
    screen.options.theme = { background: style.backgroundColor, foreground: style.color, cursor: style.color }
    return true
  }
  const scrollToBottom = () => screen?.scrollToBottom()
  const attachHistory = () => {
    const element = screen.element
    let gesture = null
    let pending = 0
    let frame = 0
    const canScroll = () => screen?.buffer.active.type === 'normal' && screen.modes.mouseTrackingMode === 'none' && !screen.hasSelection() && !window.getSelection()?.toString()
    const update = () => {
      const buffer = screen.buffer.active
      readingHistory.value = buffer.type === 'normal' && buffer.viewportY < buffer.baseY
    }
    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (pending && canScroll()) screen.scrollLines(pending)
        pending = 0
        update()
      })
    }
    const cancel = () => { gesture = null; pending = 0 }
    const start = event => {
      cancel()
      if (event.touches.length !== 1 || !canScroll() || event.target.closest('.scrollbar, textarea, input')) return
      const touch = event.touches[0]
      gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, lastY: touch.clientY, remainder: 0, at: performance.now(), scrolling: false }
    }
    const move = event => {
      if (!gesture || event.touches.length !== 1 || !canScroll()) { cancel(); return }
      const touch = event.touches[0]
      if (touch.identifier !== gesture.id) { cancel(); return }
      if (!gesture.scrolling) {
        // Leave taps, long-press selection and horizontal/multi-touch gestures to the browser.
        if (performance.now() - gesture.at > 350) { cancel(); return }
        const dy = Math.abs(touch.clientY - gesture.y)
        const dx = Math.abs(touch.clientX - gesture.x)
        if (dy < 10 && dx < 10) return
        if (dx >= dy || !event.cancelable) { cancel(); return }
        gesture.scrolling = true
        gesture.rowHeight = element.querySelector('.xterm-screen')?.getBoundingClientRect().height / screen.rows
      }
      if (!event.cancelable) { cancel(); return }
      event.preventDefault()
      const height = gesture.rowHeight
      if (!height) return
      const delta = gesture.remainder + gesture.lastY - touch.clientY
      const lines = Math.trunc(delta / height)
      gesture.remainder = delta - lines * height
      gesture.lastY = touch.clientY
      pending += lines
      schedule()
    }
    const end = () => { gesture = null }
    element.addEventListener('touchstart', start, { passive: true })
    element.addEventListener('touchmove', move, { passive: false })
    element.addEventListener('touchend', end, { passive: true })
    element.addEventListener('touchcancel', cancel, { passive: true })
    const listeners = [screen.onScroll(schedule), screen.onWriteParsed(schedule)]
    update()
    return () => {
      if (frame) cancelAnimationFrame(frame)
      element.removeEventListener('touchstart', start)
      element.removeEventListener('touchmove', move)
      element.removeEventListener('touchend', end)
      element.removeEventListener('touchcancel', cancel)
      for (const listener of listeners) listener.dispose()
    }
  }
  const paste = text => {
    if (status.value !== 'running') return false
    // Reserve the possible bracketed-paste delimiters before xterm transforms the text.
    if (inputBytes(text, TERMINAL_LIMITS.dataFrameBytes - pendingInput - 12) > TERMINAL_LIMITS.dataFrameBytes - pendingInput - 12) {
      errorCode.value = 'terminal_input_overflow'
      return false
    }
    screen.paste(text)
    return true
  }
  function onPaste(event) {
    event.preventDefault()
    event.stopImmediatePropagation()
    paste(event.clipboardData?.getData('text/plain') || '')
  }

  const heartbeat = () => {
    if (Date.now() - lastMessage >= 75000) { fail('terminal_disconnected'); return }
    if (control({ type: 'ping' })) later('heartbeat', heartbeat, 30000)
  }
  const renew = async () => {
    const current = epoch
    const id = sessionId.value
    try {
      await request('terminal_renew', { sessionId: id })
      if (current === epoch) later('renew', renew, 45000)
    } catch (error) { if (current === epoch) fail(error.message) }
  }

  const open = async container => {
    if (disposed || ['creating', 'starting', 'running'].includes(status.value)) return false
    stop('creating')
    const current = epoch
    try {
      getTerminalBase(apiIndex)
      const availability = await request('terminal_status')
      if (current !== epoch) return false
      if (!availability?.enabled) throw new Error('terminal_disabled')
      if (!availability.connected) throw new Error('terminal_agent_offline')
      if (!availability.supported || availability.protocol !== 1 || availability.platform !== 'linux') throw new Error('terminal_unsupported')
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/xterm/css/xterm.css')
      ])
      if (current !== epoch) return false
      host = container
      const style = getComputedStyle(container)
      screen = new Terminal({
        cursorBlink: true, disableStdin: true, scrollback: 1000, screenReaderMode: true,
        fontFamily: style.getPropertyValue('--terminal-font').trim() || 'Consolas, "Liberation Mono", monospace', fontSize: 14,
        theme: { background: style.getPropertyValue('--bg-primary').trim() || '#0d1117', foreground: style.getPropertyValue('--text-primary').trim() || '#c9d1d9' }
      })
      fit = new FitAddon()
      screen.loadAddon(fit)
      screen.open(container)
      historyDispose = attachHistory()
      refreshTheme()
      const rendering = renderEpoch
      fitScreen()
      input = new Uint8Array(TERMINAL_LIMITS.dataFrameBytes)
      sentInput = ackedInput = receivedOutput = consumedOutput = ackedOutput = pendingInput = 0
      bufferSince = 0
      subscriptions.push(
        screen.onData(text => { if (current === epoch) sendInput(text) }),
        screen.onBinary(text => { if (current === epoch) sendInput(text, true) }),
        screen.onResize(({ cols, rows }) => { if (current === epoch) resize(cols, rows) })
      )
      container.addEventListener('paste', onPaste, true)
      screen.attachCustomKeyEventHandler(event => {
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyC' && screen.hasSelection()) {
          if (event.type === 'keydown') void copyTextToClipboard(screen.getSelection())
          return false
        }
        return true
      })
      observer = new ResizeObserver(() => {
        if (rendering !== renderEpoch) return
        if (!timers.has('resize')) later('resize', fitScreen, BATCH_MS)
      })
      observer.observe(container)
      const session = await request('terminal_open', { clientRequestId: crypto.randomUUID(), cols: screen.cols, rows: screen.rows })
      if (current !== epoch) { notifyClose(session?.sessionId); return false }
      sessionId.value = session?.sessionId || ''
      ws = new WebSocket(getTerminalSocketUrl(serverId, sessionId.value, session?.browserPath, apiIndex))
      ws.binaryType = 'arraybuffer'
      const socket = ws
      status.value = 'starting'
      later('start', () => fail('terminal_start_timeout'), TERMINAL_LIMITS.startTimeoutMs)
      later('renew', renew, 45000)
      socket.addEventListener('open', () => {
        if (current !== epoch) return
        lastMessage = Date.now()
        later('heartbeat', heartbeat, 30000)
      })
      let started = false
      socket.addEventListener('message', event => {
        if (current !== epoch) return
        lastMessage = Date.now()
        try {
          if (typeof event.data === 'string') {
            const frame = parseTerminalControl(event.data, 'broker')
            if (frame.type === 'start') {
              if (started || status.value !== 'starting') throw new Error('terminal_protocol_error')
              started = true
              screen.resize(frame.cols, frame.rows)
            } else if (frame.type === 'ready') {
              if (!started || status.value !== 'starting') throw new Error('terminal_protocol_error')
              cancelTimer('start')
              status.value = 'running'
              screen.options.disableStdin = false
              fitScreen()
              screen.focus()
            } else if (frame.type === 'ack') {
              if (frame.bytes < ackedInput || frame.bytes > sentInput) throw new Error('terminal_protocol_error')
              if (frame.bytes > ackedInput) { ackedInput = frame.bytes; inputStall(); flushInput() }
            } else if (frame.type === 'exit') {
              stop('exited', frame.code === 0 ? '' : 'terminal_process_exit', true, true)
            } else if (frame.type === 'error') {
              fail(frame.code)
            } else if (frame.type === 'ping') {
              control({ type: 'pong' })
            } else if (frame.type !== 'pong') throw new Error('terminal_protocol_error')
          } else {
            if (status.value !== 'running' || !validateTerminalDataFrame(event.data)) throw new Error('terminal_protocol_error')
            const data = new Uint8Array(event.data)
            if (receivedOutput + data.byteLength - ackedOutput > TERMINAL_LIMITS.creditBytes) throw new Error('terminal_credit_exceeded')
            const wasIdle = receivedOutput === consumedOutput
            receivedOutput += data.byteLength
            if (wasIdle) outputStall()
            screen.write(data, () => {
              if (rendering !== renderEpoch || disposed) return
              consumedOutput += data.byteLength
              if (current !== epoch) {
                if (consumedOutput === receivedOutput) { cancelTimer('drain'); drainUntil = 0 }
                return
              }
              outputStall()
              if (consumedOutput - ackedOutput >= 32768) { cancelTimer('ack'); flushAck() }
              else if (!timers.has('ack')) later('ack', flushAck, BATCH_MS)
            })
          }
        } catch (error) { fail(/^terminal_/.test(error.message) ? error.message : 'terminal_protocol_error') }
      })
      socket.addEventListener('close', () => { if (current === epoch) fail('terminal_disconnected') })
      socket.addEventListener('error', () => { if (current === epoch) fail('terminal_disconnected') })
      return true
    } catch (error) {
      if (current === epoch) fail(/^terminal_/.test(error.message) ? error.message : 'terminal_request_failed')
      return false
    }
  }

  const close = () => stop('disconnected', '', true, true)
  const pageExit = () => dispose()
  const logoutEvent = () => { dispose(); errorCode.value = 'terminal_login_required' }
  const storageChange = event => { if (event.key === 'jwt_token' && !event.newValue) logoutEvent() }
  const dispose = () => {
    if (disposed) return
    stop('disconnected')
    disposed = true
    window.removeEventListener('pagehide', pageExit)
    window.removeEventListener('terminal-logout', logoutEvent)
    window.removeEventListener('storage', storageChange)
    channel?.close()
    channel = null
  }
  window.addEventListener('pagehide', pageExit)
  window.addEventListener('terminal-logout', logoutEvent)
  window.addEventListener('storage', storageChange)
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel('cfsm-terminal-logout')
    channel.onmessage = event => { if (event.data?.type === 'logout') logoutEvent() }
  }
  return {
    status, errorCode, sessionId, finalOutput, readingHistory, open, resize, close, dispose, sendInput, paste, refreshTheme, scrollToBottom,
    focus: () => screen?.focus(),
    copySelection: () => screen?.hasSelection()
      ? copyTextToClipboard(screen.getSelection())
      : Promise.resolve(false)
  }
}
