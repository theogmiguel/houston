import { AUTO_TERMINAL_PALETTE, THEME_LABELS, THEMES, type TerminalPalette, type TerminalPaletteChoice } from '../../theme'
import { Select } from '../Select'

const PALETTE_CHIP_KEYS: readonly (keyof TerminalPalette)[] = [
  'background',
  'foreground',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan'
]

export function TerminalPalettePicker({
  palette,
  paletteName,
  value,
  onChange
}: {
  palette: TerminalPalette
  paletteName: string
  value: TerminalPaletteChoice
  onChange: (value: TerminalPaletteChoice) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-[var(--space-2)]">
      <span aria-hidden data-testid="palette-chips" className="flex gap-[var(--space-1)]">
        {PALETTE_CHIP_KEYS.map((key) => (
          <i
            key={key}
            className="block h-[13px] w-[13px] rounded-[var(--tr-radius-input)] border border-[var(--divider)]"
            style={{ background: palette[key] }}
          />
        ))}
      </span>
      <Select
        aria-label="Terminal palette"
        data-testid="palette-select"
        value={value}
        options={[
          { value: AUTO_TERMINAL_PALETTE, label: `Auto — ${paletteName}` },
          ...THEMES.map((theme) => ({ value: theme, label: THEME_LABELS[theme] }))
        ]}
        onChange={(next) => onChange(next as TerminalPaletteChoice)}
      />
    </div>
  )
}
