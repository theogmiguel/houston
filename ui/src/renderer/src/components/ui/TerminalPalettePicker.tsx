import { AUTO_TERMINAL_PALETTE, DEFAULT_TERMINAL_PALETTE_FOR_CHROME, TERMINAL_PALETTES, THEME_LABELS, THEMES, type ChromeTheme, type TerminalPaletteChoice, type ThemeName } from '../../theme'

type Palette = NonNullable<(typeof TERMINAL_PALETTES)[ThemeName]>

const PALETTE_COLORS: readonly (keyof Palette)[] = [
  'red', 'green', 'yellow', 'blue', 'magenta', 'cyan'
]

/** Shown before "All N palettes"; the selected palette is always added when it is not one of them. */
export const FEATURED_PALETTES: readonly ThemeName[] = [
  'warm-espresso', 'warp-dark', 'dracula', 'solarized-dark', 'gruvbox-dark', 'light', 'solarized-light'
]

export function visiblePalettes(value: TerminalPaletteChoice, expanded: boolean): ThemeName[] {
  if (expanded) return [...THEMES]
  const featured = [...FEATURED_PALETTES]
  if (value !== AUTO_TERMINAL_PALETTE && !featured.includes(value)) featured.push(value)
  return featured
}

export function TerminalPalettePicker({
  chromeTheme,
  value,
  onChange,
  expanded = true
}: {
  chromeTheme: ChromeTheme
  value: TerminalPaletteChoice
  onChange: (value: TerminalPaletteChoice) => void
  /** False shows the featured palettes only; the page heading owns the "All N palettes" toggle. */
  expanded?: boolean
}): React.JSX.Element {
  const autoPalette = DEFAULT_TERMINAL_PALETTE_FOR_CHROME[chromeTheme]
  const active = value === AUTO_TERMINAL_PALETTE ? autoPalette : value
  return (
    <div className="flex flex-col gap-[var(--space-2-5)]" data-testid="terminal-palette-picker">
      <PalettePreview palette={TERMINAL_PALETTES[active]} />
      <div className="grid grid-cols-2 gap-[var(--space-2-5)] sm:grid-cols-4" role="group" aria-label="Terminal palette">
        <PaletteTile
          testId="palette-tile-auto"
          palette={TERMINAL_PALETTES[autoPalette]}
          label={`Auto · ${THEME_LABELS[autoPalette]}`}
          note={`follows ${chromeTheme === 'graphite' ? 'Graphite' : 'Paper'}`}
          pressed={value === AUTO_TERMINAL_PALETTE}
          onClick={() => onChange(AUTO_TERMINAL_PALETTE)}
        />
        {visiblePalettes(value, expanded).map((theme) => (
          <PaletteTile
            key={theme}
            testId={`palette-tile-${theme}`}
            palette={TERMINAL_PALETTES[theme]}
            label={THEME_LABELS[theme]}
            pressed={value === theme}
            onClick={() => onChange(theme)}
          />
        ))}
      </div>
    </div>
  )
}

function PalettePreview({ palette }: { palette: Palette }): React.JSX.Element {
  return (
    <div
      className="overflow-hidden rounded-[var(--tr-radius-card)] border border-[var(--border)] px-[var(--space-4)] py-[var(--space-3)] font-mono [font-size:var(--tr-text-ui-size)] leading-[1.35]"
      style={{ background: palette.background, color: palette.foreground }}
      data-testid="palette-preview"
    >
      <div><span style={{ color: palette.cyan }}>~/Houston</span> <span style={{ color: palette.magenta }}>feat/tasks-backlog</span> <span style={{ color: palette.green }}>❯</span> cargo test -p houston-core</div>
      <div><span className="pl-[var(--space-6)]" style={{ color: palette.green }}>Compiling</span> houston-core v0.42.0</div>
      <div>test result: <span style={{ color: palette.green }}>ok</span>. 214 passed; <span style={{ color: palette.red }}>1 failed</span>; 3 ignored</div>
      <div><span style={{ color: palette.yellow }}>✳</span> Edited <span style={{ color: palette.blue }}>ui/src/renderer/src/App.tsx</span> <span style={{ color: palette.green }}>+12</span> <span style={{ color: palette.red }}>−3</span></div>
      <div><span className="opacity-60">Il1O0  {'{}[]()  => != ==='}</span> <span aria-hidden="true" style={{ background: palette.foreground, color: palette.background }}>{' '}</span></div>
    </div>
  )
}

function PaletteTile({ testId, palette, label, note, pressed, onClick }: {
  testId: string
  palette: Palette
  label: string
  note?: string
  pressed: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={note ? undefined : label}
      data-testid={testId}
      className="flex flex-col overflow-hidden rounded-[var(--tr-radius-button)] border border-[var(--border)] bg-[var(--card-bg)] p-0 text-left [font-size:var(--tr-text-small-size)] hover:border-[var(--border-hover)] aria-pressed:border-[var(--accent)]"
      onClick={onClick}
    >
      <span className="flex h-[70px] flex-col justify-between px-[var(--space-2-5)] py-[var(--space-2)] font-mono [font-size:var(--tr-text-small-size)]" style={{ background: palette.background, color: palette.foreground }} aria-hidden="true">
        <span>❯ ls -la</span>
        <span className="flex gap-[var(--space-1)]">
          {PALETTE_COLORS.map((key) => <i key={key} className="h-2 w-2 rounded-full" style={{ background: palette[key] }} />)}
        </span>
      </span>
      <span className="flex min-w-0 items-baseline justify-between gap-[var(--space-2)] border-t border-[var(--divider)] px-[var(--space-2-5)] py-[var(--space-1-5)] text-[var(--text-primary)]">
        <span className="truncate">{label}</span>
        {note && <span className="flex-none [font-size:var(--tr-text-label-size)] text-[var(--text-muted)]">{note}</span>}
      </span>
    </button>
  )
}
