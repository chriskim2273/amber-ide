import type { DetailedHTMLProps, HTMLAttributes } from 'react'

// Electron's <webview> tag as a JSX intrinsic. The renderer tsconfig excludes
// electron types on purpose (it must not reach main-process APIs), so this is a
// minimal, self-contained typing of only the attributes/methods Browser.tsx
// uses — NOT the full Electron.WebviewTag.

// The subset of WebviewTag methods/events Browser.tsx drives via a ref.
export interface AmberWebview extends HTMLElement {
  src: string
  loadURL(url: string): Promise<void>
  getURL(): string
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  reload(): void
  stop(): void
}

interface WebviewAttributes extends HTMLAttributes<AmberWebview> {
  src?: string
  partition?: string
  allowpopups?: string // presence-as-string, e.g. "true"; omit to disallow
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<WebviewAttributes, AmberWebview>
    }
  }
}
