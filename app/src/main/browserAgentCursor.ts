interface CursorTransport { isAttached(): boolean; send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> }
/** A private debugger overlay, never page DOM or the desktop/OS pointer. */
export class BrowserAgentCursor {
  private timer: ReturnType<typeof setTimeout> | null = null
  private point: { x: number; y: number } | null = null
  private revision = 0
  private disposed = false
  constructor(private readonly transport: CursorTransport, private readonly nativeDeviceScale: () => number = () => 1) {}
  show(point: { x: number; y: number }): void {
    if (this.disposed) return
    this.point = { ...point }
    if (this.timer) return
    const revision = this.revision
    this.timer = setTimeout(() => {
      this.timer = null
      const current = this.point
      if (!current || this.disposed || revision !== this.revision || !this.transport.isAttached()) return
      void this.transport.send('Overlay.enable').then(() => {
        if (this.disposed || revision !== this.revision) return
        const { x, y } = current
        // Chromium Overlay quads multiply native display DPR again (crbug.com/437807128).
        // Compensate only the marker; input remains in viewport CSS coordinates.
        const dpr = this.nativeDeviceScale(), scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
        const quad = [x, y, x + 10, y + 4, x + 4, y + 10, x, y].map(value => value / scale)
        return this.transport.send('Overlay.highlightQuad', { quad,
          color: { r: 255, g: 172, b: 40, a: 0.9 }, outlineColor: { r: 35, g: 25, b: 10, a: 1 } })
      }).catch(() => {})
    }, 17)
    this.timer.unref()
  }
  async hide(): Promise<void> {
    this.revision++
    if (this.timer) clearTimeout(this.timer)
    this.timer = null; this.point = null
    if (this.transport.isAttached()) await this.transport.send('Overlay.hideHighlight').catch(() => {})
  }
  async suspend(): Promise<() => void> {
    const point = this.point
    const hiding = this.hide()
    const revision = this.revision
    await hiding
    return () => { if (point && !this.disposed && this.revision === revision) this.show(point) }
  }
  dispose(): void { this.disposed = true; void this.hide() }
}
