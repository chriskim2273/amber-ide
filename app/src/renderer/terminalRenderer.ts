export interface AddonHost {
  loadAddon(addon: unknown): void
}

export interface DisposableAddon {
  dispose(): void
}

/**
 * WebGL can fail synchronously when Chromium reports no WebGL2 context (for
 * example on a software-only display). xterm's DOM renderer is already active,
 * so dispose the failed addon and keep rendering through that fallback.
 */
export function loadOptionalWebgl(host: AddonHost, addon: DisposableAddon): boolean {
  try {
    host.loadAddon(addon)
    return true
  } catch {
    addon.dispose()
    return false
  }
}
