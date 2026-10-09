import type { Command, PaletteActions } from '../components/commandRegistry'
import { getMascotPrefs, type MascotAction } from './mascotPrefs'
import { getMascotPosition, returnMascotToRail } from './mascotPosition'

export function mascotCommands(actions: PaletteActions): Command[] {
  if (!getMascotPrefs().enabled) return []
  const commands: Command[] = ([['pet', 'Pet Houston'], ['hi', 'Say hi'], ['disco', 'Disco mode'], ['game', 'Play Ring Invaders'], ['intro', 'Replay mascot intro']] as [MascotAction, string][]).map(([action, title]) => ({
    id: `mascot.${action}`, title, group: 'Mascot' as const, enabled: true, run: () => actions.mascotAction?.(action)
  }))
  if (getMascotPosition().kind === 'floating') commands.push({
    id: 'mascot.dock', title: 'Return mascot to rail', group: 'Mascot' as const, enabled: true,
    run: () => { returnMascotToRail(); actions.mascotAction?.('dock') }
  })
  return commands
}
