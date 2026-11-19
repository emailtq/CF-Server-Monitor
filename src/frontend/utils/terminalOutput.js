export function terminalWebUrl(text) {
  if (typeof text !== 'string' || !/^https?:\/\//i.test(text) || /[\s\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\\]/u.test(text)) return ''
  try {
    const url = new URL(text)
    return ['https:', 'http:'].includes(url.protocol) && url.hostname && !url.username && !url.password ? url.href : ''
  } catch (_) { return '' }
}

export function downloadTerminalScreen(text) {
  if (!text.trim()) return false
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const anchor = document.createElement('a')
  try {
    anchor.href = url
    anchor.download = `terminal-current-screen-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
    document.body.append(anchor)
    anchor.click()
    return true
  } finally {
    anchor.remove()
    // Leave the browser a task to consume the download before revoking its URL.
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}
