export const copyTextToClipboard = async (text) => {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch (_) {
      return false
    }
  }

  if (typeof document === 'undefined') return false
  // Plain HTTP: fill the native copy event without disturbing input/xterm focus or selection.
  const put = event => { event.clipboardData?.setData('text/plain', text); event.preventDefault() }
  document.addEventListener('copy', put)
  try { return document.execCommand('copy') === true }
  catch (_) { return false }
  finally { document.removeEventListener('copy', put) }
}
