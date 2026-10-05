import { AUTO_TERMINAL_PALETTE, DEFAULT_TERMINAL_PALETTE_FOR_CHROME, TERMINAL_PALETTES, THEME_LABELS, THEMES, type ChromeTheme, type TerminalPaletteChoice, type ThemeName } from '../../theme'

const PALETTE_COLORS: readonly (keyof NonNullable<(typeof TERMINAL_PALETTES)[ThemeName]>)[] = [
  'red', 'green', 'yellow', 'blue', 'magenta', 'cyan'
]

export function TerminalPalettePicker({
  chromeTheme,
  value,
  onChange
}: {
  chromeTheme: ChromeTheme
  value: TerminalPaletteChoice
  onChange: (value: TerminalPaletteChoice) => void
}): React.JSX.Element {
  const active = value === AUTO_TERMINAL_PALETTE ? DEFAULT_TERMINAL_PALETTE_FOR_CHROME[chromeTheme] : value
  const palette = TERMINAL_PALETTES[active]
  return (
    <div className="flex flex-col gap-[var(--space-3)]" data-testid="terminal-palette-picker">
      <div
        className="overflow-hidden rounded-[var(--tr-radius-card)] border border-[var(--border)] p-[var(--space-3)] font-mono [font-size:var(--tr-text-small-size)]"
        style={{ background: palette.background, color: palette.foreground }}
        data-testid="palette-preview"
      >
        <div className="flex flex-col gap-[var(--space-1)]">
          <div className="flex items-center justify-between opacity-70"><span>~/Houston</span><span>feat/settings</span></div>
          <div className="flex gap-[var(--space-2)]"><span style={{ color: palette.green }}>❯</span><span>cargo test -p houston-core</span></div>
          <div className="opacity-70">test result: <span style={{ color: palette.green }}>ok</span>. 214 passed; 0 failed</div>
          <div><span style={{ color: palette.cyan }}>✳</span> Edited <span style={{ color: palette.blue }}>ui/src/renderer/src/App.tsx</span> <span style={{ color: palette.green }}>+12</span> <span style={{ color: palette.red }}>−3</span></div>
        </div>
        <div className="flex gap-[3px]" aria-hidden="true">
          {PALETTE_COLORS.map((key) => <span key={key} className="h-[var(--space-1)] flex-1 rounded-[var(--tr-radius-input)]" style={{ background: palette[key] }} />)}
        </div>
      </div>
      <div className="grid grid-cols-4 gap-[var(--space-2)]" role="group" aria-label="Terminal palette">
        <button
          type="button"
          aria-pressed={value === AUTO_TERMINAL_PALETTE}
          data-testid="palette-tile-auto"
          className="flex min-h-[var(--h-ctl)] flex-col justify-between rounded-[var(--tr-radius-button)] border border-[var(--border)] px-[var(--space-2)] py-[var(--space-2)] text-left [font-size:var(--tr-text-small-size)] aria-pressed:border-[var(--border-active)] aria-pressed:bg-[var(--card-hover)]"
          onClick={() => onChange(AUTO_TERMINAL_PALETTE)}
        >
          <span>Auto</span><span className="text-[var(--text-muted)]">follows {chromeTheme === 'graphite' ? 'Graphite' : 'Paper'}</span>
        </button>
        {THEMES.map((theme) => {
          const swatch = TERMINAL_PALETTES[theme]
          return (
            <button
              key={theme}
              type="button"
              aria-pressed={value === theme}
              data-testid={`palette-tile-${theme}`}
              aria-label={THEME_LABELS[theme]}
              className="flex min-h-[var(--h-ctl)] items-end justify-between gap-[var(--space-2)] rounded-[var(--tr-radius-button)] border border-[var(--border)] px-[var(--space-2)] py-[var(--space-2)] text-left [font-size:var(--tr-text-small-size)] aria-pressed:border-[var(--border-active)] aria-pressed:bg-[var(--card-hover)]"
              onClick={() => onChange(theme)}
            >
              <span>{THEME_LABELS[theme]}</span>
              <span className="flex flex-none gap-[2px]" aria-hidden="true">
                {PALETTE_COLORS.slice(0, 3).map((key) => <i key={key} className="h-2 w-2 rounded-full" style={{ background: swatch[key] }} />)}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
