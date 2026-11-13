import { findOSConfig, getOSName } from '../../../utils/osIcon.js'

export const formatAdminOS = value => {
  const raw = String(value || '').trim(), name = getOSName(raw)
  if (findOSConfig(raw).name === 'Unknown') return name
  const product = {
    Windows: '(?:Microsoft\\s+)?Windows(?:\\s+Server)?',
    macOS: '(?:macOS|Mac OS X|Mac OS)',
    'Red Hat': 'Red Hat(?: Enterprise Linux)?',
    CentOS: 'CentOS(?: Stream| Linux)?',
    'Oracle Linux': 'Oracle Linux(?: Server)?',
    openSUSE: 'openSUSE(?: Leap| Tumbleweed)?'
  }[name] || name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Only a number adjacent to the product is a release; kernel/build and Darwin versions are not.
  const release = raw.match(new RegExp(`^(${product})(?:\\s+(?:GNU/Linux|Linux))?\\s+(?:version\\s+|v)?(\\d+)(?:\\.\\d+)*(?=\\s|$|[(-])`, 'i'))
  if (!release) return name
  const label = name === 'Windows' && /server/i.test(release[1]) ? 'Windows Server' : name
  return `${label} ${release[2]}`
}

const regionNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' })
export const getAdminCountryCode = value => {
  const reported = String(value || '').trim().toUpperCase(), code = reported === 'UK' ? 'GB' : reported
  return /^[A-Z]{2}$/.test(code) && code !== 'ZZ' && regionNames.of(code) ? code : ''
}
