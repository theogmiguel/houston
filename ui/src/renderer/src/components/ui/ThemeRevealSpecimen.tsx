import { useState } from 'react'
import { TERMINAL_PALETTES, type ChromeTheme } from '../../theme'
import { revealThemeFromClick, THEME_REVEAL_DURATION_MS } from '../../themeReveal'
import { Button } from './Button'
import { ThemePaletteTable } from './ThemePaletteTable'

const PAPER_TERMINAL = TERMINAL_PALETTES.marble

export function ThemeRevealSpecimen(): React.JSX.Element {
  const [theme, setTheme] = useState<ChromeTheme>('graphite')
  const [slow, setSlow] = useState(true)

  function switchTheme(origin: HTMLElement): void {
    revealThemeFromClick(
      origin,
      () => setTheme((current) => current === 'graphite' ? 'paper' : 'graphite'),
      slow ? THEME_REVEAL_DURATION_MS * 4 : THEME_REVEAL_DURATION_MS
    )
  }

  return (
    <section
      data-testid="theme-reveal-specimen"
      data-theme={theme}
      className="grid gap-[var(--space-4)] rounded-[var(--tr-radius-card)] border border-[var(--divider)] bg-[var(--content-bg)] p-[var(--space-4)] text-[var(--text-primary)]"
    >
      <header className="flex flex-wrap items-center gap-[var(--space-2)]">
        <div className="grid flex-1 gap-[var(--space-1)]">
          <h2 className="text-[length:var(--tr-text-heading-size)] font-semibold">Theme reveal</h2>
          <p className="text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]">
            Switches from the clicked control. Paper previews the corrected Marble terminal palette.
          </p>
        </div>
        <Button variant="secondary" onClick={(event) => switchTheme(event.currentTarget)}>
          Switch to {theme === 'graphite' ? 'Paper' : 'Graphite'}
        </Button>
        <Button variant="secondary" aria-pressed={slow} onClick={() => setSlow((value) => !value)}>
          Slow reveal {slow ? 'on' : 'off'}
        </Button>
      </header>
      <div className="grid grid-cols-2 gap-[var(--space-2)] rounded-[var(--tr-radius-button)] border border-[var(--divider)] p-[var(--space-3)] font-mono text-[length:var(--tr-text-small-size)]" style={{ background: PAPER_TERMINAL.background, color: PAPER_TERMINAL.foreground }}>
        <span style={{ color: PAPER_TERMINAL.brightBlack }}>❯</span>
        <span style={{ color: PAPER_TERMINAL.red }}>git status -sb</span>
        <span className="col-span-2">## ui/p4-themes...origin/ui/p4-themes</span>
        <span style={{ color: PAPER_TERMINAL.green }}>✓</span>
        <span style={{ color: PAPER_TERMINAL.green }}>all palette inks meet 3:1</span>
        <span style={{ color: PAPER_TERMINAL.yellow }}>note</span>
        <span style={{ color: PAPER_TERMINAL.brightYellow }}>Marble on Paper</span>
      </div>
      <ThemePaletteTable />
    </section>
  )
}
