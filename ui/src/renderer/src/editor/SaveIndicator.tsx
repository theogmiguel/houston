import type { SaveState } from './useEditorSurface'
import { DiffLoadingMark } from '../components/ui'
import { IconCheck, IconLoaderCircle } from '../components/icons'
import { ICON_ROLE_CLS } from '../components/ui/Icon'

export function SaveIndicator({ state }: { state: SaveState }): React.JSX.Element {
  if (state === 'saving') {
    return (
      <DiffLoadingMark><IconLoaderCircle className={`${ICON_ROLE_CLS.label} flex-none text-[var(--text-muted)]`} aria-label="Saving" /></DiffLoadingMark>
    )
  }
  return <IconCheck className={`${ICON_ROLE_CLS.label} flex-none text-success`} aria-label="Saved" />
}
