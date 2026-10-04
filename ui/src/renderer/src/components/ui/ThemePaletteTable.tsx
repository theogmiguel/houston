import { TERMINAL_PALETTES, THEME_LABELS, THEMES } from '../../theme'
import { Table, type TableColumn } from './Table'

const CHROMATIC_COLORS = [
  'red', 'green', 'yellow', 'blue', 'magenta', 'cyan',
  'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan'
] as const

function relativeLuminance(hex: string): number {
  const channels = hex.slice(1).match(/.{2}/g)!.map((channel) => parseInt(channel, 16) / 255)
  const linear = channels.map((channel) => channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4)
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground)
  const second = relativeLuminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

type PaletteRow = {
  label: string
  background: string
  foregroundContrast: string
  minimumContrast: string
  swatches: string
}

const rows: PaletteRow[] = THEMES.map((theme) => {
  const palette = TERMINAL_PALETTES[theme]
  const ansiContrasts = CHROMATIC_COLORS.map((color) => ({
    color,
    hex: palette[color]!,
    contrast: contrastRatio(palette[color]!, palette.background!)
  }))
  const minimum = ansiContrasts.reduce((lowest, current) => current.contrast < lowest.contrast ? current : lowest)
  return {
    label: THEME_LABELS[theme],
    background: palette.background!,
    foregroundContrast: `${contrastRatio(palette.foreground!, palette.background!).toFixed(2)}:1`,
    minimumContrast: `${minimum.color} · ${minimum.contrast.toFixed(2)}:1`,
    swatches: ansiContrasts.map(({ hex }) => hex).join(' ')
  }
})

const columns: TableColumn<PaletteRow>[] = [
  { key: 'label', header: 'Palette' },
  {
    key: 'background', header: 'Background', render: (value) => {
      const background = String(value)
      return (
      <span className="inline-flex items-center gap-[var(--space-1-5)] font-mono">
        <i className="block h-[var(--space-3)] w-[var(--space-3)] rounded-full border border-[var(--divider)]" style={{ backgroundColor: background }} />
        {background}
      </span>
      )
    }
  },
  {
    key: 'swatches', header: 'ANSI · 12 colors', render: (value) => (
      <span className="inline-flex gap-[var(--space-1)]" aria-label="ANSI color palette">
        {String(value).split(' ').map((hex, index) => <i key={`${hex}-${index}`} className="block h-[var(--space-2)] w-[var(--space-2)] rounded-full" style={{ backgroundColor: hex }} />)}
      </span>
    )
  },
  { key: 'foregroundContrast', header: 'Foreground', numeric: true },
  { key: 'minimumContrast', header: 'Lowest ANSI', numeric: true }
]

export function ThemePaletteTable(): React.JSX.Element {
  return (
    <section className="grid gap-[var(--space-2)]" aria-labelledby="theme-palette-contrast-heading">
      <h2 id="theme-palette-contrast-heading" className="text-[length:var(--tr-text-subhead-size)] font-semibold">Terminal palette contrast</h2>
      <Table columns={columns} rows={rows} getRowId={(row) => row.label} aria-label="Terminal palette contrast ratios" variant="framed" />
    </section>
  )
}
