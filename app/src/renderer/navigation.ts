export function clearZoomForDestination(zoom: Record<string, string>, destination: string): Record<string, string> {
  if (!(destination in zoom)) return zoom
  const next = { ...zoom }
  delete next[destination]
  return next
}
