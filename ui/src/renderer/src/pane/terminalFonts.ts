export const TERMINAL_FONT_DEFAULT =
  '"JetBrainsMono Nerd Font", "JetBrains Mono", "MesloLGS Nerd Font", ' +
  '"Symbols Nerd Font Mono", "SF Mono", Menlo, Monaco, monospace'

export interface TerminalFontChoice {
  id: string
  label: string
  stack: string
  note?: string
}

export const TERMINAL_FONTS: TerminalFontChoice[] = [
  {
    id: 'nerd',
    label: 'Nerd Font (recommended)',
    stack: TERMINAL_FONT_DEFAULT,
    note: 'Draws Powerline prompt glyphs; the others show tofu boxes.'
  },
  {
    id: 'jetbrains',
    label: 'JetBrains Mono',
    stack: '"JetBrains Mono", "SF Mono", Menlo, Monaco, monospace',
    note: 'No icon glyphs — Powerline prompts show boxes.'
  },
  {
    id: 'system',
    label: 'System monospace',
    stack: 'ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace',
    note: 'Whatever this machine uses for code.'
  }
]

export function terminalFontStack(id: string | null): string {
  return TERMINAL_FONTS.find((f) => f.id === id)?.stack ?? TERMINAL_FONT_DEFAULT
}
