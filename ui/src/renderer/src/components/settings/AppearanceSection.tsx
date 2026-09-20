import { FOCUS_HALO, RING_ACCENT_SOLID } from '../shadowChrome'
import {
  AUTO_TERMINAL_PALETTE,
  CHROME_THEME_LABELS,
  CHROME_THEMES,
  TERMINAL_PALETTES,
  THEME_LABELS,
  THEMES,
  resolveTerminalPalette,
  type ChromeTheme,
  type TerminalPalette,
  type TerminalPaletteChoice
} from '../../theme'
import { Segmented } from '../Segmented'
import { Select } from '../Select'
import { Group, Row, SectionHead } from './shared'
import { Toggle } from '../settingsPrimitives'
import {
  RAIL_VIEWS,
  RAIL_VIEW_LABEL,
  setRailViewHidden,
  useHiddenRailViews
} from '../../railView'
import { WindowBackgroundGroup } from './WindowBackgroundGroup'
import { setContextBarVisible, useContextBarVisible } from '../../contextBarPref'

const CHROME_THEME_TAGS: Record<ChromeTheme, string> = {
  graphite: 'Default',
  paper: 'Light'
}

const PALETTE_CHIP_KEYS: readonly (keyof TerminalPalette)[] = [
  'background',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'foreground'
]

const ZOOM_STOPS: { pct: '90' | '100' | '110' | '125'; factor: number }[] = [
  { pct: '90', factor: 0.9 },
  { pct: '100', factor: 1 },
  { pct: '110', factor: 1.1 },
  { pct: '125', factor: 1.25 }
]

export interface AppearanceSectionProps {
  chromeTheme: ChromeTheme
  onChromeTheme: (t: ChromeTheme) => void
  theme: TerminalPaletteChoice
  onTheme: (t: TerminalPaletteChoice) => void
  uiZoom: number
  onUiZoom: (z: number) => void
}

function ContextBarToggle(): React.JSX.Element {
  const visible = useContextBarVisible()
  return (
    <Row
      title="Show context bar"
      desc="A strip at the bottom reads the focused agent's context usage. Hidden providers read “not tracked”."
    >
      <Toggle
        on={visible}
        data-testid="context-bar-toggle"
        onChange={setContextBarVisible}
      />
    </Row>
  )
}

function SidebarRowToggles(): React.JSX.Element {
  const hidden = useHiddenRailViews()
  return (
    <>
      {RAIL_VIEWS.map((v) => (
        <Row
          key={v}
          title={RAIL_VIEW_LABEL[v]}
          desc={`Show ${RAIL_VIEW_LABEL[v]} in the sidebar, above the workspace tree.`}
        >
          <Toggle
            on={!hidden.has(v)}
            data-testid={`sidebar-row-toggle-${v}`}
            onChange={(on) => setRailViewHidden(v, !on)}
          />
        </Row>
      ))}
    </>
  )
}

export function AppearanceSection({
  chromeTheme,
  onChromeTheme,
  theme,
  onTheme,
  uiZoom,
  onUiZoom
}: AppearanceSectionProps): React.JSX.Element {
  const resolvedTheme = resolveTerminalPalette(theme, chromeTheme)
  const palette = TERMINAL_PALETTES[resolvedTheme]

  return (
    <>
      <SectionHead
        title="Appearance"
        lede="Two independent axes: the chrome theme paints the app, the palette paints what is inside your terminals."
      />

      <Group heading="Chrome theme" plain>
        <div
          role="radiogroup"
          aria-label="Chrome theme"
          className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-[var(--space-3)] mt-[var(--space-2)] mb-[var(--space-4)]"
        >
          {CHROME_THEMES.map((t) => {
            const on = chromeTheme === t
            return (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={on}
                data-testid="chrome-theme-tile"
                data-chrome-theme={t}
                onClick={() => onChromeTheme(t)}
                className={`btn flex flex-col p-0 overflow-hidden rounded-[var(--tr-radius-card)] border text-left whitespace-normal [transition:border-color_.12s_ease,transform_.12s_ease] motion-safe:hover:-translate-y-px focus-visible:outline-none ${
                  on
                    ? `border-[var(--accent)] shadow-[${RING_ACCENT_SOLID}] bg-[var(--card-bg)] focus-visible:shadow-[${RING_ACCENT_SOLID},${FOCUS_HALO}]`
                    : `border-[var(--border)] hover:border-[var(--border-hover)] bg-[var(--card-bg)] focus-visible:shadow-[${FOCUS_HALO}]`
                }`}
              >
                <span
                  data-theme={t}
                  data-testid="chrome-theme-swatch"
                  className="flex h-[76px] w-full flex-col justify-between p-2 bg-[var(--content-bg)]"
                >
                  <span className="block h-[5px] w-3/5 rounded-[3px] bg-[var(--accent)]" />
                  <span className="flex gap-[3px]">
                    <i className="block h-[5px] w-[5px] rounded-full bg-[var(--text-primary)]" />
                    <i className="block h-[5px] w-[5px] rounded-full bg-[var(--text-secondary)]" />
                    <i className="block h-[5px] w-[5px] rounded-full bg-[var(--border)]" />
                  </span>
                </span>
                <span className="flex w-full items-center justify-between gap-[var(--space-1-5)] border-t border-t-[var(--divider)] px-[var(--space-2-5)] py-[var(--space-2)]">
                  <b className="min-w-0 truncate text-[length:var(--tr-text-small-size)] font-medium text-[var(--text-primary)]">
                    {CHROME_THEME_LABELS[t]}
                  </b>
                  <span
                    data-testid="chrome-theme-tag"
                    className={`shrink-0 font-mono [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] uppercase ${
                      on ? 'text-[var(--accent)]' : 'text-[var(--text-faint)]'
                    }`}
                  >
                    {CHROME_THEME_TAGS[t]}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </Group>

      <WindowBackgroundGroup chromeTheme={chromeTheme} palette={palette} />

      <Group heading="Terminal palette">
        <Row
          title="Palette"
          desc="The canvas your agents print onto."
        >
          <div className="flex items-center gap-[var(--space-2)]">
            <span
              aria-hidden
              data-testid="palette-chips"
              className="flex gap-[3px]"
            >
              {PALETTE_CHIP_KEYS.map((k) => (
                <i
                  key={k}
                  className="block h-[13px] w-[13px] rounded-[3px] border border-[var(--divider)]"
                  style={{ background: TERMINAL_PALETTES[resolvedTheme][k] }}
                />
              ))}
            </span>
            <Select
              aria-label="Terminal palette"
              data-testid="palette-select"
              value={theme}
              options={[
                {
                  value: AUTO_TERMINAL_PALETTE,
                  label: `Auto — ${THEME_LABELS[resolvedTheme]}`
                },
                ...THEMES.map((t) => ({ value: t, label: THEME_LABELS[t] }))
              ]}
              onChange={(v) => onTheme(v as TerminalPaletteChoice)}
            />
          </div>
        </Row>
      </Group>

      <Group heading="Sidebar">
        {}
        <SidebarRowToggles />
      </Group>

      <Group heading="Interface">
        <Row
          title="App zoom"
          desc="Scales the whole app. Ctrl +/− does the same."
        >
          <Segmented<'90' | '100' | '110' | '125'>
            aria-label="App zoom"
            options={ZOOM_STOPS.map((s) => ({ value: s.pct, label: `${s.pct}%` }))}
            value={ZOOM_STOPS.find((s) => Math.round(s.factor * 100) === Math.round(uiZoom * 100))?.pct}
            onChange={(pct) => onUiZoom(ZOOM_STOPS.find((s) => s.pct === pct)!.factor)}
          />
        </Row>
        <ContextBarToggle />
      </Group>
    </>
  )
}
