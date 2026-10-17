import type { PaletteActions } from './commandRegistry'

type PaletteNav = Pick<PaletteActions, 'stepWorkspace' | 'selectLastWorkspace' | 'stepGrid'>

// A navigation command with nowhere to go is disabled with its reason, so each move
// is offered only when it can act.
export function paletteNavActions(
  nav: Required<PaletteNav> & {
    workspaceCount: number
    lastWorkspace: string | null
    selectedWs: string
    gridsFor: (path: string) => readonly unknown[]
  }
): PaletteNav {
  const gridsToStep = nav.selectedWs !== 'all' && nav.gridsFor(nav.selectedWs).length > 1
  return {
    stepWorkspace: nav.workspaceCount > 0 ? nav.stepWorkspace : undefined,
    selectLastWorkspace: nav.lastWorkspace !== null ? nav.selectLastWorkspace : undefined,
    stepGrid: gridsToStep ? nav.stepGrid : undefined
  }
}
