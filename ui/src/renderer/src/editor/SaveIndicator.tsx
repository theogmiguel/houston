import type { SaveState } from './useEditorSurface'
import { SaveStateMark } from '../components/ui'

export function SaveIndicator({ state }: { state: SaveState }): React.JSX.Element {
  return <SaveStateMark saving={state === 'saving'} />
}
