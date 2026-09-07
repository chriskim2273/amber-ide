import { randomUUID } from 'node:crypto'

export interface ObservationLease { browserId: string; pageIncarnation: string; generation: number; controller?: string; documentEpoch?: number }
export interface EffectiveBrowserViewport { width: number; height: number; pageX: number; pageY: number }
export interface ScreenshotObservation extends ObservationLease {
  screenshotId: string; imageWidth: number; imageHeight: number
  viewport: EffectiveBrowserViewport; viewportRevision: number; capturedAt: number; coordinateSpace: 'image-pixels'; coordinateActionable: true
}
export class BrowserObservations {
  private readonly entries = new Map<string, ScreenshotObservation>()
  constructor(private readonly now = () => performance.now()) {}
  clear(): void { this.entries.clear() }
  isFresh(record: ScreenshotObservation): boolean { return this.now() - record.capturedAt <= 60000 }
  issue(input: ObservationLease & { imageWidth: number; imageHeight: number; viewport: EffectiveBrowserViewport; viewportRevision?: number }): ScreenshotObservation {
    const record: ScreenshotObservation = { ...input, viewport: { ...input.viewport }, screenshotId: randomUUID(), capturedAt: this.now(), viewportRevision: input.viewportRevision ?? 0, coordinateSpace: 'image-pixels', coordinateActionable: true }
    while (this.entries.size >= 4) this.entries.delete(this.entries.keys().next().value!)
    this.entries.set(record.screenshotId, record)
    return structuredClone(record)
  }
  resolve(lease: ObservationLease, screenshotId: string): ScreenshotObservation {
    const record = this.entries.get(screenshotId)
    if (!record || !this.isFresh(record) || record.documentEpoch !== lease.documentEpoch || record.browserId !== lease.browserId || record.pageIncarnation !== lease.pageIncarnation || record.generation !== lease.generation || record.controller !== lease.controller) throw new Error('STALE_GENERATION')
    return structuredClone(record)
  }
}
export function mapScreenshotPoint(observation: ScreenshotObservation, point: { x: number; y: number }): { x: number; y: number } {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x >= observation.imageWidth || point.y >= observation.imageHeight) throw new Error('INVALID_REQUEST')
  return { x: Math.floor(point.x * observation.viewport.width / observation.imageWidth), y: Math.floor(point.y * observation.viewport.height / observation.imageHeight) }
}
export function sameViewport(a: EffectiveBrowserViewport, b: EffectiveBrowserViewport): boolean {
  return a.width === b.width && a.height === b.height && a.pageX === b.pageX && a.pageY === b.pageY
}
