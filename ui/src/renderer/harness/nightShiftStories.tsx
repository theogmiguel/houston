import { NightShiftSetup } from '../src/components/nav/NightShiftSetup'
import { NightShiftReport } from '../src/components/nav/NightShiftReport'
import { NIGHT_NOW, nightDefaults, nightEntry, nightRun } from '../src/test/nightShiftFixtures'
import type { NightDetected } from '../src/houston/generated/NightDetected'
import type { NightEntry } from '../src/houston/generated/NightEntry'
import type { NightShiftSettings } from '../src/houston/generated/NightShiftSettings'

const DETECTED: NightDetected = {
  checks: [
    { command: 'cargo fmt --all --check --manifest-path core/Cargo.toml', source: 'ci.yml · core-checks' },
    { command: 'cargo clippy --all-targets --manifest-path core/Cargo.toml -- -D warnings', source: 'ci.yml · core-checks' },
    { command: 'cd ui && bun run typecheck', source: 'ci.yml · renderer-checks' }
  ],
  start_command: { command: 'node ui/harness/shot.mjs <story> <out.png>', source: 'ui/harness/shot.mjs' },
  apps: [{ name: 'Orca', version: '1.4.238', path: 'C:\\Users\\you\\AppData\\Local\\Programs\\orca\\Orca.exe' }],
  apps_note: null
}

/** Routines ▸ Night shift ▸ Setup with the checks found in a repository; `open` turns on the
 * areas and options that reveal more. */
export function NightShiftSetupStory({ open = false }: { open?: boolean }): React.JSX.Element {
  const base: NightShiftSettings = { ...nightDefaults(), checks: DETECTED.checks }
  const settings: NightShiftSettings = open
    ? {
        ...base,
        focus: { ...base.focus, ui_polish: 'normal', competitor_gaps: 'high' },
        competitors: [{ kind: 'repo', repo: 'pingdotgg/t3code' }, { kind: 'app', ...DETECTED.apps[0] }],
        app_qa: { enabled: true, start_command: DETECTED.start_command!.command, source: DETECTED.start_command!.source, address: '', smoke_flows: [] },
        output: 'merge_queue',
        enabled: true,
        window: { ...base.window, nights: [2, 3, 4, 5] },
        live_workers: 6
      }
    : base
  return (
    <div className="h-full overflow-auto p-[var(--space-4)]">
      <NightShiftSetup settings={settings} revision="r" verifyCommand={open} childCap={6} detected={DETECTED} onSave={() => {}} onRunNow={() => {}} />
    </div>
  )
}

const gates = (over: Partial<NightEntry['gates']> = {}): NightEntry['gates'] => ({
  checks: 'passed', review: 'passed', qa: 'passed', ci: 'passed', verify: 'passed', reruns: 0, fixes: 0, ...over
})

/** Routines ▸ Night shift ▸ Morning report with fixer panes, CI re-runs and per-provider tokens. */
export function NightShiftReportStory(): React.JSX.Element {
  const run = nightRun({
    phase: 'settled', ended_at_ms: NIGHT_NOW, stop_reason: 'report', summary: 'Two pull requests, one flaky retry and one more fixer.',
    entries: [
      nightEntry({ id: 1, kind: 'pr', title: 'Tray fix', theme: 'reliability', pr_number: 12, visible: true,
        gates: gates({ ci: 'failed', reruns: 1, fixes: 2 }) }),
      nightEntry({ id: 2, kind: 'pr', title: 'Faster diff', theme: 'performance', pr_number: 13, visible: true,
        gates: gates({ fixes: 1 }) }),
      nightEntry({ id: 3, kind: 'decision', title: 'Drop the old API?', body: 'It has no callers.\n\nOptions: keep | remove' })
    ]
  })
  return (
    <div className="h-full overflow-auto p-[var(--space-4)]">
      <NightShiftReport run={run} report={null} workers={['zcode', 'claude']} holdForQa onDecide={() => {}} onQaPassed={() => {}} onLoadReport={() => {}} />
    </div>
  )
}
