import { resourcePressureMessage, shouldResumeParkedPane, type ResourcePressure } from './store'

export function ResourcePressureBanner({ pressure }: { pressure: ResourcePressure }): JSX.Element {
  return (
    <div className="banner memory-banner critical" role="alert">
      <span className="dot" />
      <span className="banner-msg">{resourcePressureMessage(pressure)}</span>
    </div>
  )
}

export function ParkedOverlay(
  { text, active, onResume }: { text: string; active: boolean; onResume: () => void },
): JSX.Element {
  return (
    <div className="memory-parked-overlay" role="status" tabIndex={0}
      aria-label={`${text}; focus to resume`}>
      <span>{text}</span>
      <button type="button" onClick={(e) => {
        if (shouldResumeParkedPane(active, e.isTrusted)) onResume()
      }}>Resume</button>
    </div>
  )
}
