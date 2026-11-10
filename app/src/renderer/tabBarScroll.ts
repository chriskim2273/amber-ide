export function enableTabWheel(bar: HTMLElement): () => void {
  const onWheel = (event: WheelEvent): void => {
    if (event.ctrlKey || event.shiftKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return
    if (bar.scrollWidth <= bar.clientWidth) return
    const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bar.clientWidth : 1
    const previous = bar.scrollLeft
    bar.scrollLeft += event.deltaY * multiplier
    if (bar.scrollLeft !== previous) event.preventDefault()
  }
  bar.addEventListener('wheel', onWheel, { passive: false })
  return () => bar.removeEventListener('wheel', onWheel)
}
