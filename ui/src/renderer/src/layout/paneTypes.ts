import type { PaneNode } from './tree'
import {
  IconCodeXml,
  IconCompass,
  IconFolder,
  IconWrench,
  type IconProps
} from '../components/icons'

export type PaneTypeKind = PaneNode['kind']

export interface PaneTypeDef {
  kind: PaneTypeKind
  label: string
  hint: string
  Icon: (p: IconProps) => React.JSX.Element
  needsWorkspace?: boolean
  insertable: boolean
}

export const PANE_TYPES: readonly PaneTypeDef[] = [
  {
    kind: 'files',
    label: 'Files',
    hint: 'Files — browse and edit workspace files',
    Icon: IconFolder,
    needsWorkspace: true,
    insertable: true
  },
  {
    kind: 'browser',
    label: 'Browser',
    hint: 'Browser — preview localhost or any URL',
    Icon: IconCompass,
    insertable: true
  },
  {
    kind: 'editor',
    label: 'Editor',
    hint: 'Editor — open and edit workspace files',
    Icon: IconCodeXml,
    needsWorkspace: true,
    insertable: false
  },
  {
    kind: 'skills',
    label: 'Skills',
    hint: 'Skills — click one to run it in a terminal',
    Icon: IconWrench,
    insertable: false
  },
] as const

export function paneTypeButtonState(
  t: PaneTypeDef,
  hasWorkspace: boolean
): { disabled: boolean; title: string } {
  const disabled = Boolean(t.needsWorkspace) && !hasWorkspace
  return { disabled, title: disabled ? `Open a workspace to use ${t.label}` : t.hint }
}
