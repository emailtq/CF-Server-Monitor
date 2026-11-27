// Native healthy buckets omit loss; legacy summaries have no attempt denominator.
export function bucketLoss(point: { loss?: number | null; source?: string }, windowLoss?: number | null): number | null {
  if (point.source === 'legacy-summary/unknown-denominator' || point.loss === null) return null
  if (typeof point.loss === 'number') return point.loss
  return typeof windowLoss === 'number' ? 0 : null
}
