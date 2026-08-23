import { resourcePressureMessage, type ResourcePressure } from './store'

export function ResourcePressureBanner({ pressure }: { pressure: ResourcePressure }): JSX.Element {
  return (
    <div className="banner memory-banner critical" role="alert">
      <span className="dot" />
      <span className="banner-msg">{resourcePressureMessage(pressure)}</span>
    </div>
  )
}
