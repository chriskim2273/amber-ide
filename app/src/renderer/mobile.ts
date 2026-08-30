// Mobile capability detection (spec 2026-08-22 §1).
//
// CAPABILITY, never host: nothing here asks whether we are in Electron or the
// browser build. A phone and a touch laptop at phone width get the same
// treatment, and the desktop app in a small window keeps its mouse chrome.
// That is what makes these renderer changes legal under the amended §2.1 rule.

import { useEffect, useState } from 'react'

/** Above this CSS width the real chrome fits, coarse pointer or not. */
export const MOBILE_MAX_WIDTH = 820

// Pocket normally uses the physical device width. The explicit desktop option
// asks the mobile browser for a conventional laptop-sized layout viewport so
// the unchanged desktop chrome can fit and be scaled down as one whole surface,
// just like a browser's “Request desktop site” mode. Pinch zoom remains enabled.
export const MOBILE_VIEWPORT_CONTENT = 'width=device-width, initial-scale=1, viewport-fit=cover'
export const DESKTOP_VIEWPORT_CONTENT = 'width=1180, viewport-fit=cover'

interface ViewportDocument {
  querySelector(selector: string): { setAttribute(name: string, value: string): void } | null
}

export function applyViewportMode(doc: ViewportDocument, desktop: boolean): boolean {
  const viewport = doc.querySelector('meta[name="viewport"]')
  if (!viewport) return false
  viewport.setAttribute('content', desktop ? DESKTOP_VIEWPORT_CONTENT : MOBILE_VIEWPORT_CONTENT)
  return true
}

const COARSE_QUERY = '(pointer: coarse)'

export function isMobileViewport(width: number, coarsePointer: boolean): boolean {
  return coarsePointer && width <= MOBILE_MAX_WIDTH
}

export type MobileViewMode = 'auto' | 'pocket' | 'desktop'

/** An explicit view selection must win while mobile browsers asynchronously
 * settle a changed viewport meta tag. `auto` preserves capability detection. */
export function isMobileMode(mobileViewport: boolean, mode: MobileViewMode): boolean {
  if (mode === 'pocket') return true
  if (mode === 'desktop') return false
  return mobileViewport
}

/** CSS pixels needed to retain a 48px physical touch target after the browser
 * scales the 1180px desktop canvas down to a phone. */
export function desktopControlSize(visualScale: number): number {
  const scale = Number.isFinite(visualScale) && visualScale > 0 ? visualScale : 1
  return 48 / scale
}

/** Live `isMobileViewport`, re-evaluated on resize, rotation and pointer change. */
export function useMobile(): boolean {
  const read = (): boolean => {
    if (typeof window === 'undefined') return false
    const coarse = window.matchMedia?.(COARSE_QUERY).matches ?? false
    return isMobileViewport(window.innerWidth, coarse)
  }
  const [mobile, setMobile] = useState(read)
  useEffect(() => {
    const update = (): void => setMobile(read())
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    // A pointer change is rare but real: a tablet gaining a mouse, or a device
    // switching input modes mid-session.
    const mq = window.matchMedia?.(COARSE_QUERY)
    mq?.addEventListener?.('change', update)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
      mq?.removeEventListener?.('change', update)
    }
  }, [])
  return mobile
}
