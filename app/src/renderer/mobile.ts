// Mobile capability detection (spec 2026-08-22 §1).
//
// CAPABILITY, never host: nothing here asks whether we are in Electron or the
// browser build. A phone and a touch laptop at phone width get the same
// treatment, and the desktop app in a small window keeps its mouse chrome.
// That is what makes these renderer changes legal under the amended §2.1 rule.

import { useEffect, useState } from 'react'

/** Above this CSS width the real chrome fits, coarse pointer or not. */
export const MOBILE_MAX_WIDTH = 820

const COARSE_QUERY = '(pointer: coarse)'

export function isMobileViewport(width: number, coarsePointer: boolean): boolean {
  return coarsePointer && width <= MOBILE_MAX_WIDTH
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
