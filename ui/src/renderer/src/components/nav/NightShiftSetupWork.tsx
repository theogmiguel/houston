import type { NightCompetitor } from '../../houston/generated/NightCompetitor'
import type { NightDetected } from '../../houston/generated/NightDetected'
import type { NightFocus } from '../../houston/generated/NightFocus'
import type { NightFocusLevel } from '../../houston/generated/NightFocusLevel'
import type { NightShiftSettings } from '../../houston/generated/NightShiftSettings'
import { Button, InfoTip, Inline, NightBox, NightDividedRow, NightGrow, NightQuestion, NightReveal, Segmented, Select, Text, TextArea, TextInput } from '../ui'
import { Switch } from '../ui/Switch'
import { FOCUS_AREAS, appQaOn, githubRepo } from './nightShiftFormat'

const ATTENTION: { value: NightFocusLevel; label: string }[] = [
  { value: 'low', label: 'Low' }, { value: 'normal', label: 'Normal' }, { value: 'high', label: 'High' }
]

/** A competitor row as typed: a repository's text stays as typed until it is valid. */
export type CompetitorRow = { kind: 'repo'; text: string } | { kind: 'app'; app: { name: string; version: string; path: string } | null }

export const COMPETITORS_MAX = 10

export function rowsOf(competitors: NightCompetitor[]): CompetitorRow[] {
  return competitors.map((c) => (c.kind === 'repo' ? { kind: 'repo', text: c.repo } : { kind: 'app', app: { name: c.name, version: c.version, path: c.path } }))
}

/** The rows that are complete, as settings entries. */
export function competitorsOf(rows: CompetitorRow[]): NightCompetitor[] {
  return rows.flatMap((r): NightCompetitor[] => {
    if (r.kind === 'app') return r.app ? [{ kind: 'app', ...r.app }] : []
    const repo = githubRepo(r.text)
    return repo ? [{ kind: 'repo', repo }] : []
  })
}

function rowStatus(row: CompetitorRow): { ok: boolean; text: string } {
  if (row.kind === 'app') {
    return row.app
      ? { ok: true, text: `${row.app.name} ${row.app.version || '(version not reported)'} · analysed with REA; the next run reads only what a newer version changed` }
      : { ok: false, text: 'Choose an app installed on this computer.' }
  }
  const repo = githubRepo(row.text)
  return repo
    ? { ok: true, text: `${repo} · cloned read-only; releases newer than the last studied tag are read` }
    : { ok: false, text: 'Enter a GitHub repository, for example github.com/owner/repo.' }
}

function CompetitorRows({ rows, detected, onRows }: { rows: CompetitorRow[]; detected: NightDetected; onRows: (rows: CompetitorRow[]) => void }): React.JSX.Element {
  const set = (i: number, row: CompetitorRow): void => onRows(rows.map((r, j) => (j === i ? row : r)))
  const appOptions = detected.apps.map((a, i) => ({ value: String(i), label: a.version ? `${a.name} ${a.version}` : a.name }))
  return (
    <NightReveal role="group" aria-label="Competitors">
      <div className="flex items-center gap-[var(--space-1)]">
        <Text size="small" tone="secondary">Competitors</Text>
        <InfoTip about="competitors">A GitHub repository is cloned read-only and its new releases are read. An app installed on this computer, with no public repository, is analysed with REA. Each run records the release or version it studied, so the next one reads only what changed. Findings are features and behaviour, never copied code.</InfoTip>
      </div>
      {rows.map((row, i) => {
        const status = rowStatus(row)
        const n = i + 1
        return (
          <NightBox key={i}>
            <Inline wrap gap="small">
              <Segmented aria-label={`Competitor ${n} kind`} size="xs" value={row.kind}
                options={[{ value: 'repo', label: 'GitHub repository' }, { value: 'app', label: 'Installed app' }]}
                onChange={(kind) => set(i, kind === 'repo' ? { kind, text: '' } : { kind, app: null })} />
              <NightGrow>
                {row.kind === 'repo'
                  ? <TextInput aria-label={`Competitor ${n} repository`} size="form" width="full" font="mono" value={row.text} placeholder="github.com/owner/repo"
                    onChange={(e) => set(i, { kind: 'repo', text: e.target.value })} />
                  : <Select aria-label={`Competitor ${n} app`} width="full" value={row.app ? String(detected.apps.findIndex((a) => a.name === row.app?.name)) : ''}
                    options={appOptions.length ? appOptions : [{ value: '', label: detected.apps_note ?? 'No installed apps found', disabled: true }]}
                    onChange={(v) => set(i, { kind: 'app', app: detected.apps[Number(v)] ?? null })} />}
              </NightGrow>
              <Button variant="ghost" size="sm" aria-label={`Remove competitor ${n}`} onClick={() => onRows(rows.filter((_, j) => j !== i))}>Remove</Button>
            </Inline>
            <Text size="small" tone={status.ok ? 'ok' : 'warn'}>{status.text}</Text>
          </NightBox>
        )
      })}
      {rows.length < COMPETITORS_MAX && <Button variant="secondary" size="sm" className="justify-self-start" onClick={() => onRows([...rows, { kind: 'repo', text: '' }])}>Add competitor</Button>}
      {rows.some((r) => r.kind === 'app') && <Text size="small" tone="warn">Installed apps need REA available to the scouts' agent; preflight checks it. Make sure the app's licence allows analysing it.</Text>}
    </NightReveal>
  )
}

/** Question 1: what the run works on — direction, focus areas and competitors. */
export function WorkOn({ draft, suggested, rows, detected, onDirection, onArea, onRows }: {
  draft: NightShiftSettings
  suggested: boolean
  rows: CompetitorRow[]
  detected: NightDetected
  onDirection: (text: string) => void
  onArea: (key: keyof NightFocus, level: NightFocusLevel) => void
  onRows: (rows: CompetitorRow[]) => void
}): React.JSX.Element {
  const anyOn = FOCUS_AREAS.some((a) => draft.focus[a.key] !== 'off')
  return (
    <NightQuestion number={1} heading="What should it work on?" badge={anyOn ? { label: 'Answered', tone: 'answered' } : { label: 'Required', tone: 'required' }}>
      <div className="grid gap-[var(--space-1)]">
        <div className="flex items-center gap-[var(--space-1)]">
          <Text size="small" tone="secondary">Direction <Text size="small" tone="muted">(optional)</Text></Text>
          <InfoTip about="Direction">Where the run should go, in plain words. Typing here suggests the focus areas below; you can still change any of them.</InfoTip>
        </div>
        <TextArea aria-label="Direction" rows={2} value={draft.direction} placeholder="e.g. Make it feel faster and stop it crashing in long sessions" onChange={(e) => onDirection(e.target.value)} />
      </div>
      <div className="grid" role="group" aria-label="Focus areas">
        <Inline wrap gap="small" align="baseline">
          <Text size="small" tone="secondary">Focus areas: turn on what matters, then pick how much attention it gets</Text>
          {suggested && <Text size="small" tone="muted">Suggested from your direction</Text>}
        </Inline>
        {FOCUS_AREAS.map((area) => {
          const level = draft.focus[area.key]
          const on = level !== 'off'
          return (
            <NightDividedRow key={area.key}>
              <Inline wrap gap="large">
                <Switch label={`${area.label} on`} on={on} onChange={(next) => onArea(area.key, next ? 'normal' : 'off')} />
                <NightGrow basis="medium">
                  <div className="flex items-center gap-[var(--space-1)]">
                    <Text weight="semibold">{area.label}</Text>
                    <InfoTip about={area.label}>{area.definition}</InfoTip>
                  </div>
                </NightGrow>
                {on && <Segmented aria-label={`${area.label} attention`} size="xs" value={level} options={ATTENTION} onChange={(next) => onArea(area.key, next)} />}
              </Inline>
              {on && area.key === 'competitor_gaps' && <CompetitorRows rows={rows} detected={detected} onRows={onRows} />}
              {on && area.key === 'ui_polish' && (
                <NightReveal>
                  <Text size="small" tone={appQaOn(draft) ? 'secondary' : 'warn'}>
                    Changes here are visible, so Screenshots stays on while this is on. {appQaOn(draft)
                      ? 'App QA (step 5 in question 2) captures them.'
                      : 'Turn on App QA, step 5 in question 2, so a QA pane can capture them; without it, workers take them only if they manage to run the app themselves.'}
                  </Text>
                </NightReveal>
              )}
            </NightDividedRow>
          )
        })}
      </div>
    </NightQuestion>
  )
}
