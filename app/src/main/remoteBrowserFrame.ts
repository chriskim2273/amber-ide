export const REMOTE_FRAME_MAX_EDGE = 900
export const REMOTE_FRAME_MAX_BYTES = 1024 * 1024

export interface RemoteFrameImage {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(opts: { width: number; height: number; quality?: 'good' | 'better' | 'best' }): RemoteFrameImage
  toJPEG(quality: number): Buffer
  toPNG(): Buffer
}

export function remoteFrameSize(width: number, height: number, maxEdge = REMOTE_FRAME_MAX_EDGE): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return { width: 1, height: 1 }
  const edge = Math.max(width, height)
  if (edge <= maxEdge) return { width: Math.round(width), height: Math.round(height) }
  const scale = maxEdge / edge
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

export function encodeRemoteFrame(image: RemoteFrameImage): { mediaType: 'image/jpeg' | 'image/png'; data: Buffer; width: number; height: number } | null {
  if (image.isEmpty()) return null
  const size = image.getSize()
  const target = remoteFrameSize(size.width, size.height)
  const scaled = size.width === target.width && size.height === target.height
    ? image
    : image.resize({ width: target.width, height: target.height, quality: 'better' })
  for (const quality of [55, 40, 28]) {
    const data = scaled.toJPEG(quality)
    if (data.length >= 8 && data.length <= REMOTE_FRAME_MAX_BYTES) {
      return { mediaType: 'image/jpeg', data, width: target.width, height: target.height }
    }
  }
  const data = scaled.toPNG()
  if (data.length < 8 || data.length > REMOTE_FRAME_MAX_BYTES) return null
  return { mediaType: 'image/png', data, width: target.width, height: target.height }
}

export function remoteSurfaceOptions(width: number, height: number): {
  show: false
  frame: false
  skipTaskbar: true
  paintWhenInitiallyHidden: true
  backgroundColor: '#ffffff'
  width: number
  height: number
} {
  return {
    show: false,
    frame: false,
    skipTaskbar: true,
    paintWhenInitiallyHidden: true,
    backgroundColor: '#ffffff',
    width: Math.max(2, Math.round(width)),
    height: Math.max(2, Math.round(height)),
  }
}
