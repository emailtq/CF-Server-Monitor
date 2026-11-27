// CF nullable counters: an incomplete aggregate is not a measured zero.
export function sumKnown(values: (number | null | undefined)[]): number | null {
  return values.reduce<number | null>((sum, value) => sum === null || value == null || !Number.isFinite(value) ? null : sum + value, 0)
}
export function trafficUsage(up: number | null | undefined, down: number | null | undefined, mode: string, used?: number | null): number | null {
  if (used !== undefined) return used
  if (mode === 'up') return up ?? null
  if (mode === 'down') return down ?? null
  if (up == null || down == null) return null
  if (mode === 'max') return Math.max(up, down)
  if (mode === 'min') return Math.min(up, down)
  return sumKnown([up, down])
}
export function trafficPercentage(used: number | null, limit: number): number | null {
  return used === null ? null : limit > 0 ? Math.min(used / limit * 100, 100) : 0
}
