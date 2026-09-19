import { BTN_GHOST } from '../buttonChrome'
import { TERMINAL_FONTS, terminalFontStack } from '../../pane/terminalFonts'
import { Select } from '../Select'
import { SettingsList, Toggle } from '../settingsPrimitives'
import {
  TERMINAL_LINE_HEIGHT_MAX,
  TERMINAL_LINE_HEIGHT_MIN,
  TERMINAL_SCROLLBACK_MAX,
  TERMINAL_SCROLLBACK_MIN
} from '../../usePreferences'
import {
  IDLE_QUIET_MS_DEFAULT,
  IDLE_QUIET_MS_MAX,
  IDLE_QUIET_MS_MIN,
  STACK_CAP_DEFAULT,
  STACK_CAP_MAX,
  STACK_CAP_MIN,
  setIdleQuietMsDefault,
  setStackCapacity,
  useIdleQuietMsDefault,
  useStackCapacity
} from '../../paneCaps'
import { ClampedNumberSetting, Row, SubHead } from './shared'

export interface TerminalSectionProps {
  fontSize: number
  onFontSize: (px: number) => void
  fontMin: number
  fontMax: number
  fontDefault: number
  fontFamilyId: string
  onFontFamilyId: (id: string) => void
  terminalLineHeight: number
  onTerminalLineHeight: (n: number) => void
  terminalCursorBlink: boolean
  onTerminalCursorBlink: (on: boolean) => void
  terminalScrollbackLines: number
  onTerminalScrollbackLines: (n: number) => void
  shellIntegration: boolean
  onShellIntegration: (on: boolean) => void
  shiftEnterNewline: boolean
  onShiftEnterNewline: (on: boolean) => void
  osc52: boolean
  onOsc52: (on: boolean) => void
  copyOnSelect: boolean
  onCopyOnSelect: (on: boolean) => void
  stripBoxGlyphs: boolean
  onStripBoxGlyphs: (on: boolean) => void
}

export function TerminalSection({
  fontSize,
  onFontSize,
  fontMin,
  fontMax,
  fontDefault,
  fontFamilyId,
  onFontFamilyId,
  terminalLineHeight,
  onTerminalLineHeight,
  terminalCursorBlink,
  onTerminalCursorBlink,
  terminalScrollbackLines,
  onTerminalScrollbackLines,
  shellIntegration,
  onShellIntegration,
  shiftEnterNewline,
  onShiftEnterNewline,
  osc52,
  onOsc52,
  copyOnSelect,
  onCopyOnSelect,
  stripBoxGlyphs,
  onStripBoxGlyphs
}: TerminalSectionProps): React.JSX.Element {
  const stackCap = useStackCapacity()
  const idleQuiet = useIdleQuietMsDefault()
  return (
    <>
      <div className="mb-[var(--space-5)]">
        <div className="text-[length:var(--tr-text-heading-size)] font-[var(--tr-text-heading-weight)] tracking-[var(--tr-text-heading-tracking)] leading-[1.25] text-[var(--text-primary)]">Terminal</div>
        <div className="mt-[var(--space-1-5)] text-[length:var(--tr-text-base)] leading-[1.6] text-[var(--text-muted)] max-w-[72ch]">
          Most changes reach open panes immediately. Shell integration and clipboard
          access apply to new terminals only.
        </div>
      </div>
      <SubHead>Type</SubHead>
      <SettingsList>
        <Row
          title="Font size"
          desc="Applies to every pane. Ctrl +/− does the same."
        >
          <div className="flex items-center gap-2">
            <div
              className="px-2 py-[3px] rounded-md border border-[var(--border)] bg-[var(--content-bg)] text-[var(--text-primary)] leading-none overflow-hidden whitespace-nowrap"
              style={{ fontFamily: terminalFontStack(fontFamilyId), fontSize: `${fontSize}px` }}
              data-testid="settings-font-preview"
            >
              Il1O0
            </div>
            <input
              type="number"
              className="w-[64px] bg-[var(--content-bg)] border border-[var(--border)] rounded-md text-[var(--text-primary)] [font-style:inherit] [font-variant:inherit] [font-weight:inherit] [font-stretch:inherit] [line-height:inherit] [font-family:inherit] [font-size:var(--tr-text-small-size)] py-[5px] px-2 text-right"
              min={fontMin}
              max={fontMax}
              step={1}
              value={fontSize}
              data-testid="settings-font-size"
              onChange={(e) => {
                const n = Math.trunc(Number(e.target.value))
                if (!Number.isFinite(n)) return
                onFontSize(Math.min(fontMax, Math.max(fontMin, n)))
              }}
            />
            <button
              type="button"
              className={`btn ${BTN_GHOST}`}
              disabled={fontSize === fontDefault}
              onClick={() => onFontSize(fontDefault)}
            >
              Reset
            </button>
          </div>
        </Row>
        <Row
          title="Font family"
          desc={
            TERMINAL_FONTS.find((f) => f.id === fontFamilyId)?.note ??
            'Applies to every terminal pane immediately'
          }
        >
          <Select
            value={fontFamilyId}
            data-testid="settings-font-family"
            options={TERMINAL_FONTS.map((f) => ({ value: f.id, label: f.label }))}
            onChange={onFontFamilyId}
          />
        </Row>
        <Row title="Line height" desc="A multiplier of font size. Below 1.0 clips descenders.">
          <ClampedNumberSetting
            value={terminalLineHeight}
            min={TERMINAL_LINE_HEIGHT_MIN}
            max={TERMINAL_LINE_HEIGHT_MAX}
            step={0.05}
            testId="settings-terminal-line-height"
            onCommit={onTerminalLineHeight}
          />
        </Row>
      </SettingsList>
      <SubHead>Behaviour</SubHead>
      <SettingsList>
        <Row title="Cursor blink">
          <Toggle
            on={terminalCursorBlink}
            onChange={onTerminalCursorBlink}
            data-testid="settings-terminal-cursor-blink"
          />
        </Row>
        <Row
          title="Scrollback"
          desc="Lines kept per pane, for new panes. A reconnect recovers only what the daemon kept."
        >
          <ClampedNumberSetting
            value={terminalScrollbackLines}
            min={TERMINAL_SCROLLBACK_MIN}
            max={TERMINAL_SCROLLBACK_MAX}
            unit="lines"
            integer
            testId="settings-terminal-scrollback"
            onCommit={onTerminalScrollbackLines}
          />
        </Row>
        <Row
          title="Shell integration"
          desc="Terminals report prompts, commands and cwd. Powers history and handoff."
        >
          <Toggle on={shellIntegration} onChange={onShellIntegration} />
        </Row>
        <Row
          title="Shift+Enter inserts a newline"
          desc="Write multi-line prompts without sending."
        >
          <Toggle on={shiftEnterNewline} onChange={onShiftEnterNewline} />
        </Row>
        <Row title="Clipboard access" desc="Lets terminal apps set the clipboard (OSC 52).">
          <Toggle on={osc52} onChange={onOsc52} />
        </Row>
        <Row
          title="Copy on select"
          desc="Selecting terminal text copies it. TUIs still need Shift-drag."
        >
          <Toggle on={copyOnSelect} onChange={onCopyOnSelect} />
        </Row>
        <Row
          title="Copy the text, not the box"
          desc="Strips TUI box-drawing borders from copied text."
        >
          <Toggle on={stripBoxGlyphs} onChange={onStripBoxGlyphs} />
        </Row>
        {}
        <Row
          title="Panes per stack"
          desc={`Tabs one grid cell may hold, ${STACK_CAP_MIN}–${STACK_CAP_MAX} (default ${STACK_CAP_DEFAULT}). Lowering it closes nothing.`}
        >
          <ClampedNumberSetting
            value={stackCap}
            min={STACK_CAP_MIN}
            max={STACK_CAP_MAX}
            integer
            unit="tabs"
            testId="settings-panes-per-stack"
            onCommit={setStackCapacity}
          />
        </Row>
        <Row
          title="Idle quiet window"
          desc={`Silence before Houston calls a session idle. ${IDLE_QUIET_MS_MIN}–${IDLE_QUIET_MS_MAX} ms, default ${IDLE_QUIET_MS_DEFAULT}.`}
        >
          <ClampedNumberSetting
            value={idleQuiet}
            min={IDLE_QUIET_MS_MIN}
            max={IDLE_QUIET_MS_MAX}
            step={50}
            integer
            unit="ms"
            testId="settings-idle-quiet-ms"
            onCommit={setIdleQuietMsDefault}
          />
        </Row>
      </SettingsList>
    </>
  )
}
