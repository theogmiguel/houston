import { IconCheck, IconLoaderCircle } from '../icons'
import { DiffLoadingMark } from './Diff'
import { ICON_ROLE_CLS } from './Icon'

/** The editor header's save state: a turning ring while a write is in flight, then a check. */
export function SaveStateMark({ saving }: { saving: boolean }): React.JSX.Element {
  if (saving) {
    return (
      <DiffLoadingMark><IconLoaderCircle className={`${ICON_ROLE_CLS.label} flex-none text-[var(--text-muted)]`} aria-label="Saving" /></DiffLoadingMark>
    )
  }
  return <IconCheck className={`${ICON_ROLE_CLS.label} flex-none text-success`} aria-label="Saved" />
}

export function SaveStateMarkSpecimen(): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-[var(--space-2)]">
      <SaveStateMark saving />
      <SaveStateMark saving={false} />
    </span>
  )
}
