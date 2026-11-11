import { AGENT_REPOSITORY } from '../../shared/agentSource.js'

const cache = new Map()
const unavailable = () => ({available:false, terminal:false, version:''})

export async function checkAgentInstallRelease(os, version = '', signal, request = fetch, checkImage) {
  const tag = version.trim() || 'latest'
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) return unavailable()
  const key = `${os}:${tag}`
  const held = cache.get(key)
  if (request === fetch && held && held.until > Date.now()) return held.value
  const options = {signal, credentials:'omit'}
  const json = async (url, extra = {}) => {
    const response = await request(url, {...options, ...extra})
    if (!response.ok) throw new Error('download_unavailable')
    return response.json()
  }
  let value = unavailable()
  try {
    if (os === 'docker') {
      const result = await checkImage?.(tag)
      value = {available:result?.available === true, terminal:false, version:tag}
    } else {
      const api = `https://api.github.com/repos/${AGENT_REPOSITORY}`
      const release = await json(`${api}/releases/${tag === 'latest' ? 'latest' : `tags/${encodeURIComponent(tag)}`}`)
      const pattern = {linux:/^cf-probe-linux-[\w]+$/,unix:/^cf-probe-(?:linux|freebsd)-[\w]+$/,mac:/^cf-probe-darwin-[\w]+$/,windows:/^cf-probe-windows-[\w]+\.exe$/}[os]
      if (!pattern || release.draft || !release.tag_name || (tag !== 'latest' && release.tag_name !== tag)) return value
      const available = release.assets?.some(asset => pattern.test(asset.name) && asset.state === 'uploaded' && asset.browser_download_url?.startsWith(`https://github.com/${AGENT_REPOSITORY}/releases/download/${release.tag_name}/`))
      if (!available) return value
      value = {available:true, terminal:false, version:release.tag_name}
      if (os === 'linux') {
        try {
          const file = await json(`${api}/contents/internal/cfprobe/cli.go?ref=${encodeURIComponent(release.tag_name)}`)
          const source = file.encoding === 'base64' ? atob(file.content.replace(/\s/g,'')) : ''
          if (/fs\.\w+Var\([^\n]*"terminal"/.test(source) && /fs\.StringVar\([^\n]*"terminal-token-file"/.test(source)) {
            const control = await json(`${api}/contents/internal/cfprobe/terminal_control.go?ref=${encodeURIComponent(release.tag_name)}`)
            value.terminal = control.encoding === 'base64' && /func \(a \*Agent\) startTerminal\(/.test(atob(control.content.replace(/\s/g,'')))
          }
        } catch (error) { if (signal?.aborted) throw error }
      }
    }
  } catch (error) { if (signal?.aborted) throw error }
  if (request === fetch && !signal?.aborted) cache.set(key, {value, until:Date.now() + 60000})
  return value
}
