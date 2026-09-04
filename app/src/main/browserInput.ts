/**
 * CDP Input-domain events are delivered through the same Electron page hooks as
 * physical user input. They must not invalidate the generation a second time.
 */
export function shouldRecordUserInput(automationInput: boolean): boolean {
  return !automationInput
}
