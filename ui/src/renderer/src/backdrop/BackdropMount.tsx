import { lazy, Suspense, type JSX } from 'react'
import { useBackgroundState } from '../backgroundMode'

// Kept split from CustomBackdrop so the mode check (needed synchronously at
// first paint) never drags the dither engine onto the boot chunk.
const CustomBackdrop = lazy(() =>
  import('./CustomBackdrop').then((m) => ({ default: m.CustomBackdrop }))
)

export function BackdropMount({
  theme,
  onUnavailable
}: {
  theme: string
  onUnavailable?: (reason: string) => void
}): JSX.Element | null {
  const { mode } = useBackgroundState()
  if (mode !== 'custom') return null
  return (
    <Suspense fallback={null}>
      <CustomBackdrop theme={theme} {...(onUnavailable ? { onUnavailable } : {})} />
    </Suspense>
  )
}
