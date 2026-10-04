import type { Command, CommandGroup } from '../commandRegistry'
import { effectiveLabel } from '../../keymap'
import type { KeymapOverrides } from '../../houston/generated/KeymapOverrides'

export const PALETTE_RECENTS_KEY = 'houston-command-palette-recents'
export const PALETTE_RECENTS_LIMIT = 8

export function groupPaletteCommands(commands: readonly Command[], recentIds: readonly string[]): { group: CommandGroup; items: Command[] }[] {
  const sessions = commands.filter((command) => command.group === 'Sessions')
  const byId = new Map(commands.map((command) => [command.id, command]))
  const recent = recentIds.flatMap((id) => {
    const command = byId.get(id)
    return command && command.group !== 'Sessions' ? [command] : []
  })
  const restart = byId.get('pane.restart-focused')
  if (restart && !recent.some((command) => command.id === restart.id)) recent.push(restart)
  const groups: { group: CommandGroup; items: Command[] }[] = []
  if (sessions.length) groups.push({ group: 'Sessions', items: sessions })
  if (recent.length) groups.push({ group: 'Recent', items: recent })
  return groups
}

export function paletteShortcutLabels(commands: readonly Command[], overrides: KeymapOverrides): Record<string, string> {
  return Object.fromEntries(commands.flatMap((command) => command.chord ? [[command.id, effectiveLabel(command.chord, overrides)]] : []))
}

export function rememberPaletteCommand(previous: readonly string[], id: string): string[] {
  return [id, ...previous.filter((recent) => recent !== id)].slice(0, PALETTE_RECENTS_LIMIT)
}

export function readPaletteRecents(storage: Pick<Storage, 'getItem'>): string[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(PALETTE_RECENTS_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(0, PALETTE_RECENTS_LIMIT) : []
  } catch {
    return []
  }
}
