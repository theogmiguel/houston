import {
  CHROME_THEME_LABELS,
  CHROME_THEMES,
  TERMINAL_PALETTES,
  resolveTerminalPalette,
  type ChromeTheme,
  type TerminalPaletteChoice
} from '../../theme'
import { Segmented } from '../ui/SegmentedControl'
import { ShellElement } from '../ui/ShellPrimitives'
import { ChoiceGrid, RadioCard, RadioCardFooter, ThemePreviewSwatch } from '../ui/RadioCard'
import { Group, Row } from './shared'
import { Toggle } from '../ui/settingsPrimitives'
import { Button } from '../ui/Button'
import {
  RAIL_VIEWS,
  RAIL_VIEW_LABEL,
  setRailViewHidden,
  useHiddenRailViews
} from '../../railView'
import { WindowBackgroundGroup } from './WindowBackgroundGroup'
import {
  setContextIndicatorVisible,
  useContextIndicatorVisible
} from '../../contextIndicatorPref'
import { useOpenDiffOnAgentStopPreference } from '../../usePreferences'

const CHROME_THEME_TAGS: Record<ChromeTheme, string> = {
  graphite: 'Default',
  paper: 'Light'
}

const ZOOM_STOPS: { pct: '90' | '100' | '110' | '125'; factor: number }[] = [
  { pct: '90', factor: 0.9 },
  { pct: '100', factor: 1 },
  { pct: '110', factor: 1.1 },
  { pct: '125', factor: 1.25 }
]

export interface AppearanceSectionProps {
  chromeTheme: ChromeTheme
  onChromeTheme: (t: ChromeTheme, origin: HTMLElement) => void
  theme: TerminalPaletteChoice
  uiZoom: number
  onUiZoom: (z: number) => void
}

function ContextIndicatorToggle(): React.JSX.Element {
  const visible = useContextIndicatorVisible()
  return (
    <Row
      title="Show context indicator"
      desc="A ring in each supported agent pane shows its context usage. Hover or focus it for details."
    >
      <Toggle
        on={visible}
        data-testid="context-indicator-toggle"
        onChange={setContextIndicatorVisible}
      />
    </Row>
  )
}

function SidebarRowToggles(): React.JSX.Element {
  const hidden = useHiddenRailViews()
  return (
    <>
      {RAIL_VIEWS.filter((v) => hidden.has(v)).map((v) => (
        <Row
          key={v}
          title={RAIL_VIEW_LABEL[v]}
          desc="Hidden from the navigation rail."
        >
          <Button variant="legacy-ghost" size="sm" data-testid={`sidebar-row-restore-${v}`} onClick={() => setRailViewHidden(v, false)}>Restore</Button>
        </Row>
      ))}
      {hidden.size === 0 && <ShellElement as="p" shellRole="appearance-hidden-empty">No hidden navigation rows.</ShellElement>}
    </>
  )
}

function PanelsSettings(): React.JSX.Element {
  const [openDiffOnAgentStop, setOpenDiffOnAgentStop] = useOpenDiffOnAgentStopPreference()
  return (
    <Group heading="Panels">
      <Row
        title="Open diff when an agent stops"
        desc="Open the Diff panel after the focused agent finishes when the workspace has changes."
      >
        <Toggle
          on={openDiffOnAgentStop}
          data-testid="open-diff-on-agent-stop-toggle"
          onChange={setOpenDiffOnAgentStop}
        />
      </Row>
    </Group>
  )
}

export function AppearanceSection({
  chromeTheme,
  onChromeTheme,
  theme,
  uiZoom,
  onUiZoom
}: AppearanceSectionProps): React.JSX.Element {
  const resolvedTheme = resolveTerminalPalette(theme, chromeTheme)
  const palette = TERMINAL_PALETTES[resolvedTheme]

  return (
    <>

      <Group heading="Chrome theme" plain>
        <ChoiceGrid
          role="radiogroup"
          columns={2}
          aria-label="Chrome theme"
        >
          {CHROME_THEMES.map((t) => {
            const on = chromeTheme === t
            return (
              <RadioCard
                key={t}
                selected={on}
                emphasis="raised"
                data-testid="chrome-theme-tile"
                data-chrome-theme={t}
                onClick={(event) => onChromeTheme(t, event.currentTarget)}
              >
                <ThemePreviewSwatch theme={t} data-testid="chrome-theme-swatch" />
                <RadioCardFooter label={CHROME_THEME_LABELS[t]} tag={CHROME_THEME_TAGS[t]} selected={on} testId="chrome-theme-tag" />
              </RadioCard>
            )
          })}
        </ChoiceGrid>
      </Group>

      <WindowBackgroundGroup chromeTheme={chromeTheme} palette={palette} />

      <Group heading="Sidebar">
        {}
        <SidebarRowToggles />
      </Group>

      <PanelsSettings />

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
        <ContextIndicatorToggle />
      </Group>
    </>
  )
}
