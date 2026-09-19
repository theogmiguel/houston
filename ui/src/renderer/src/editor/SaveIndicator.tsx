import type { SaveState } from './useEditorSurface'
import { SPIN_CLASS } from '../components/git/DiffBody'
import { IconCheck, IconLoaderCircle } from '../components/icons'
import { ICON_ROLE_CLS } from '../components/Icon'

export function SaveIndicator({ state }: { state: SaveState }): React.JSX.Element {
  if (state === 'saving') {
    return (
      <IconLoaderCircle
        className={`${ICON_ROLE_CLS.label} flex-none text-[var(--text-muted)] ${SPIN_CLASS}`}
        aria-label="Saving"
      />
    )
  }
  return <IconCheck className={`${ICON_ROLE_CLS.label} flex-none text-success`} aria-label="Saved" />
}
