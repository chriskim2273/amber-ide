// CLI-shaped helpers only. Anything the RENDERER needs lives in `shared/`:
// a value import from `main/` would pull main-process module code into the
// Electron renderer bundle and the browser build.
export type {
  PiProviderState,
  RouterKey,
  RouterSlot,
  RouterStatus,
} from '../shared/routerStatus'
export { moveSlot, parseRouterStatus, routerDot, slotFromWire, slotToWire } from '../shared/routerStatus'

export function routerCtlArgv(action: string, port: number): string[] {
  return ['ctl', 'router', action, '--json', '--port', String(port)]
}
