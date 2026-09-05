export interface ElectronPathDefaults {
  userData: string
  sessionData: string
}

export function electronPaths(env: NodeJS.ProcessEnv, defaults: ElectronPathDefaults): ElectronPathDefaults {
  return {
    userData: env['AMBER_ELECTRON_USER_DATA'] ?? defaults.userData,
    sessionData: env['AMBER_ELECTRON_CACHE'] ?? defaults.sessionData,
  }
}
