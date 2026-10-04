import React, { useState } from 'react'
import {
  BarSparkline,
  Button,
  Card,
  Caption as UiCaption,
  Chip,
  Count,
  ConnectionCell,
  DoneDisclosure,
  Drawer,
  EmptyState,
  Field,
  IconTile,
  ListDetail,
  Notice,
  PageFrame,
  PageHeader,
  PaneHeaderButton,
  SectionHead,
  Select,
  Segmented,
  STATUS_LABELS,
  StatusLabel,
  RoutineDetail,
  Table,
  TaskProgress,
  TaskAcceptanceRow,
  TaskDetailFrame,
  TaskDrawerCard,
  TaskDrawerExecutionPanel,
  TaskDrawerHeader,
  TaskDrawerOrigin,
  Tooltip,
  UsageCalendar,
  UsageChart,
  UsageShareBar
} from '../src/components/ui'
import { IconAlertTriangle, IconCheck, IconClose, IconPlus, IconSearch } from '../src/components/icons'

const noop = (): void => {}

const breakdownRows = [
  { rank: 1, model: 'claude-opus-5-5', cost: '$1,812.30', share: '72.9%', tokens: '2.9B', bar: 72.9 },
  { rank: 2, model: 'gpt-5.5-codex', cost: '$402.10', share: '16.2%', tokens: '498M', bar: 16.2 },
  { rank: 3, model: 'claude-sonnet-5-5', cost: '$259.10', share: '10.4%', tokens: '1.2B', bar: 10.4 },
  { rank: 4, model: 'gpt-5.5-codex-mini', cost: '$12.80', share: '0.5%', tokens: '14M', bar: 0.5 }
]

const routineItems = [
  { id: 'harness', title: 'Harness review · houston', sub: 'Working' },
  { id: 'nightly', title: 'Nightly dependency check', sub: 'Waiting for a slot' },
  { id: 'weekly', title: 'Weekly changelog draft', sub: 'Idle · Fri 17:00' },
  { id: 'flaky', title: 'Flaky test sweep', sub: 'Paused' }
]
const options = [
  { value: 'graphite', label: 'Graphite' },
  { value: 'paper', label: 'Paper' },
  { value: 'disabled', label: 'Unavailable', disabled: true }
]

function SpecimenGroup({ heading, children }: { heading: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section style={{ display: 'grid', gap: 'var(--space-3)' }}>
      <h2 style={{ margin: 0, color: 'var(--text-primary)', fontSize: 'var(--tr-text-heading-size)' }}>{heading}</h2>
      {children}
    </section>
  )
}

function SpecimenRow({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-3)' }}>{children}</div>
}

function Caption({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span style={{ color: 'var(--text-muted)', fontSize: 'var(--tr-text-small-size)' }}>{children}</span>
}

export function UiPrimitivesStory(): React.JSX.Element {
  const [selectedRoutine, setSelectedRoutine] = useState<string | null>('nightly')
  const [drawerOpen, setDrawerOpen] = useState(false)
  return (
    <div
      className="ui-primitives-specimen"
      style={{ height: '100%', overflow: 'auto', color: 'var(--text-primary)', background: 'var(--content-bg)' }}
    >
      <style>{'@media (prefers-reduced-motion: reduce) { .ui-primitives-specimen *, .ui-primitives-specimen *::before, .ui-primitives-specimen *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; transition-duration: 0.01ms !important; } }'}</style>
      <div style={{ display: 'grid', gap: 'var(--space-5)', maxWidth: 1180, margin: '0 auto', padding: 24 }}>
        <header style={{ display: 'grid', gap: 'var(--space-1)' }}>
          <h1 style={{ margin: 0, fontSize: 'var(--tr-text-title-size)' }}>UI primitives</h1>
          <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
            Every component exported from components/ui, with its variants and representative states.
          </p>
          <Caption>Motion preference: {window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduced' : 'full'}</Caption>
        </header>

        <SpecimenGroup heading="Button">
          <SpecimenRow>
            <Button variant="primary" icon={IconPlus}>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="link">Link</Button>
            <Button variant="danger">Danger</Button>
            <Button variant="danger" armed icon={IconAlertTriangle}>Armed</Button>
            <Button variant="danger-solid" icon={IconAlertTriangle}>Danger solid</Button>
            <Button variant="icon" icon={IconClose} aria-label="Close" />
            <Button variant="text">Task row title</Button>
          </SpecimenRow>
          <SpecimenRow>
            <Button variant="primary" size="sm">Primary small</Button>
            <Button variant="secondary" size="sm">Secondary small</Button>
            <Button variant="ghost" size="sm">Ghost small</Button>
            <Button variant="danger" size="sm">Danger small</Button>
            <Button variant="danger-solid" size="sm" icon={IconAlertTriangle}>Danger small</Button>
          </SpecimenRow>
          <SpecimenRow>
            <Button variant="primary" disabled>Disabled primary</Button>
            <Button variant="secondary" disabled>Disabled secondary</Button>
            <Button variant="ghost" disabled>Disabled ghost</Button>
            <Button variant="danger" disabled>Disabled danger</Button>
            <Button variant="icon" icon={IconClose} aria-label="Disabled close" disabled />
          </SpecimenRow>
        </SpecimenGroup>

        <SpecimenGroup heading="Card and Card.Row">
          <Card>
            <Card.Row heading="Default card" meta="Heading and supporting detail" status={<StatusLabel status="Working" />} action={<Button size="sm">Open</Button>} />
            <Card.Row heading="Second row" meta="Rows keep their shared structure" />
            <Card.Row density="compact" heading="Compact queue row" meta="HOU-45 · Claude Code needs input" status={<StatusLabel status="Ready" />} action={<Button size="sm">Review changes</Button>} />
          </Card>
          <Card>
            <Card.Group rail="new"><SectionHead title="New" count={1} /><Card.Row heading="New review group" meta="Amber rule" /></Card.Group>
            <Card.Group rail="still"><SectionHead title="Still there" count={1} /><Card.Row heading="Still there group" meta="Stop rule" /></Card.Group>
            <Card.Group rail="gone"><SectionHead title="Gone" count={1} /><Card.Row heading="Gone review group" meta="Ok rule" /></Card.Group>
            <Card.Row compact rail="new" heading="Compact history row" meta="One line for recent history" />
          </Card>
          <Card><Card.Content><Card.Row heading="Grouped content" meta="Card.Content owns the section spacing" /></Card.Content></Card>
          <Card tone="inset"><Card.Row heading="Inset card" meta="Alternate surface tone" /></Card>
        </SpecimenGroup>

        <SpecimenGroup heading="BarSparkline">
          <SpecimenRow><BarSparkline values={[41, 33, 25, 18]} label="Repeated mistakes per 100 sessions: 41 to 18" /><Caption>Trend across reviews</Caption></SpecimenRow>
        </SpecimenGroup>

        <SpecimenGroup heading="Caption">
          <UiCaption>Supporting text and coverage details.</UiCaption>
        </SpecimenGroup>

        <SpecimenGroup heading="Task progress">
          <div style={{ maxWidth: 560 }}><TaskProgress status="in_progress" /></div>
        </SpecimenGroup>

        <SpecimenGroup heading="Task page primitives">
          <TaskDetailFrame>
            <TaskDrawerHeader taskKey="HOU-42" workspace="houston" heading="Block bun test in agent settings" status="in_progress" actions={<Button variant="icon" icon={IconClose} aria-label="Task actions" />} />
            <TaskDrawerCard><TaskAcceptanceRow checked text="bun test is denied in .claude/settings.json" onToggle={noop} /><TaskAcceptanceRow checked={false} text="AGENTS.md points to bun run test" onToggle={noop} /></TaskDrawerCard>
          </TaskDetailFrame>
          <TaskDrawerOrigin><Chip variant="compound" label="From Harness finding · bun-test" /></TaskDrawerOrigin>
          <DoneDisclosure count={3}><Card><Card.Row heading="Completed task" meta="HOU-41 · From Harness" /></Card></DoneDisclosure>
        </SpecimenGroup>

        <SpecimenGroup heading="Count">
          <SpecimenRow><span>Tasks<Count value={12} /></span><span>Zero omitted<Count value={0} /></span><span>Zero shown<Count value={0} showZero /></span></SpecimenRow>
          <SpecimenRow><span>Primary ink<Count value={4} from="primary" /></span><span>Secondary ink<Count value={4} from="secondary" /></span><span>Attention<Count value={4} from="accent" /></span></SpecimenRow>
        </SpecimenGroup>

        <SpecimenGroup heading="StatusLabel">
          <SpecimenRow>{STATUS_LABELS.map((status) => <StatusLabel key={status} status={status} />)}</SpecimenRow>
        </SpecimenGroup>

        <SpecimenGroup heading="RoutineDetail and ConnectionCell">
          <SpecimenRow>
            <ConnectionCell status="Failed" reason="npx was not found on PATH" server="github" agent="Claude Code" onClick={noop} />
            <ConnectionCell status="Differs" server="postgres-local" agent="OpenCode" onClick={noop} />
            <ConnectionCell status="Off" server="linear" agent="Cursor" onClick={noop} />
          </SpecimenRow>
          <RoutineDetail
            routine={{ id: 1, name: 'Nightly dependency check', prompt: 'Check packages', cadence: { type: 'clock', hour: 2, minute: 0, weekdays: null }, enabled: true, engine: 'claude', next_run_at_ms: Date.now(), last_run_at_ms: null, permission_mode: 'accept_edits', isolate: false, revision: 'specimen' }}
            runs={[]}
            runsLoading={false}
            now={Date.now()}
            running={false}
            pending={false}
            atLimit={{ running: 3, limit: 3 }}
            waitingForSlot
            onRunNow={noop}
            onToggleEnabled={noop}
            onEdit={noop}
            onDelete={noop}
            onUpdateSchedule={noop}
            onUpdateEngine={noop}
            onOpenSession={noop}
          />
        </SpecimenGroup>

        <SpecimenGroup heading="PageFrame, PageHeader and SectionHead">
          <PageFrame width="form" style={{ border: '1px dashed var(--border)' }}>
            <PageHeader heading="Form width" description="A one sentence description." count={3} actions={<Button variant="primary" icon={IconPlus}>New item</Button>} />
            <SectionHead title="Section" count={2} action={<Button variant="ghost" size="sm">View all</Button>} />
          </PageFrame>
          <PageFrame width="wide" style={{ border: '1px dashed var(--border)' }}>
            <PageHeader heading="Wide width" />
            <SectionHead title="Empty count" count={0} />
          </PageFrame>
        </SpecimenGroup>

        <SpecimenGroup heading="Field">
          <div style={{ display: 'grid', gap: 'var(--space-3)', maxWidth: 420 }}>
            <Field label="Workspace" hint="Choose a project folder."><input value="/home/dev/code/houston" readOnly /></Field>
            <Field label="Required field" error="A value is required."><input value="" readOnly aria-invalid="true" /></Field>
            <Field label="Disabled field" hint="This value is managed elsewhere."><input value="Managed" readOnly disabled /></Field>
          </div>
        </SpecimenGroup>

        <SpecimenGroup heading="EmptyState">
          <SpecimenRow>
            <div style={{ flex: '1 1 360px', padding: 24, border: '1px solid var(--divider)' }}>
              <EmptyState icon={IconSearch} heading="No results" description="Try a different search." action={{ label: 'Clear search', onClick: noop }} />
            </div>
            <div style={{ flex: '1 1 360px', padding: 24, border: '1px solid var(--divider)' }}>
              <EmptyState icon={IconPlus} heading="No workspace" description="Choose a workspace to get started." variant="window" />
            </div>
          </SpecimenRow>
        </SpecimenGroup>

        <SpecimenGroup heading="PaneHeaderButton">
          <SpecimenRow><PaneHeaderButton icon={IconClose} aria-label="Close pane" /><PaneHeaderButton icon={IconPlus} aria-label="Add pane" /><PaneHeaderButton icon={IconClose} aria-label="Disabled close pane" disabled /></SpecimenRow>
        </SpecimenGroup>

        <SpecimenGroup heading="Select">
          <SpecimenRow>
            <Select value="graphite" options={options} onChange={noop} aria-label="Theme" />
            <Select value="paper" options={options} onChange={noop} aria-label="Disabled theme" disabled />
          </SpecimenRow>
        </SpecimenGroup>

        <SpecimenGroup heading="Segmented">
          <SpecimenRow>
            <Segmented aria-label="Filter" options={[{ value: 'active', label: 'Active', count: 4 }, { value: 'resolved', label: 'Resolved', count: 1 }, { value: 'dismissed', label: 'Dismissed' }]} value="active" onChange={noop} />
            <Segmented aria-label="Disabled choice" options={[{ value: 'one', label: 'One' }, { value: 'two', label: 'Two', disabled: true }]} value="two" />
            <Segmented aria-label="Loading choice" options={[{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }]} value="one" loading />
          </SpecimenRow>
          <Segmented aria-label="Error choice" options={[]} error={{ message: 'Could not load options.', onRetry: noop }} />
        </SpecimenGroup>

        <SpecimenGroup heading="Table — Usage breakdown">
          <Table
            aria-label="Usage breakdown by model"
            rows={breakdownRows}
            getRowId={(row) => row.model}
            columns={[
              { key: 'rank', header: '#', tone: 'faint', width: 'var(--space-5)' },
              { key: 'model', header: 'Model', render: (value, row) => (
                <span className="grid gap-[var(--space-1)]">
                  <span>{value}</span>
                  <span aria-hidden="true" className="h-0.5 rounded-full bg-[var(--text-primary)]" style={{ width: `${row.bar}%`, maxWidth: 220 }} />
                </span>
              ) },
              { key: 'cost', header: 'Cost', numeric: true, width: '100px' },
              { key: 'share', header: 'Share', numeric: true, tone: 'muted', width: '64px' },
              { key: 'tokens', header: 'Tokens', numeric: true, tone: 'muted', width: '64px' }
            ]}
          />
        </SpecimenGroup>

        <SpecimenGroup heading="Usage chart, calendar and shares">
          <div style={{ maxWidth: 900 }}><UsageChart metric="cost" points={[
            { startMs: 0, key: 'Mon', byProvider: { claude: { cost: 120, tokens: 0 }, codex: { cost: 45, tokens: 0 } } },
            { startMs: 1, key: 'Tue', byProvider: { claude: { cost: 180, tokens: 0 }, codex: { cost: 90, tokens: 0 } } },
            { startMs: 2, key: 'Wed', byProvider: { claude: { cost: 130, tokens: 0 }, codex: { cost: 60, tokens: 0 } } },
            { startMs: 3, key: 'Thu', byProvider: { claude: { cost: 230, tokens: 0 }, codex: { cost: 110, tokens: 0 } } }
          ]} series={[{ provider: 'claude', label: 'Claude Code', color: 'var(--accent)' }, { provider: 'codex', label: 'Codex', color: 'var(--text-primary)' }]} labelFor={(point) => point.key} /></div>
          <UsageCalendar days={[]} metric="cost" selectedDay={null} onSelect={noop} />
          <UsageShareBar heading="Cost by type" segments={[{ id: 'input', label: 'Input', value: 58 }, { id: 'cache-read', label: 'Cache read', value: 24 }, { id: 'output', label: 'Output', value: 18 }]} />
        </SpecimenGroup>

        <SpecimenGroup heading="ListDetail — Routines">
          <PageFrame width="wide" className="p-0">
            <ListDetail
              items={routineItems}
              selectedId={selectedRoutine}
              onSelect={setSelectedRoutine}
              backLabel="Back to routines"
              renderDetail={(item) => item && (
                <div className="grid gap-[var(--space-3)]">
                  <div className="flex flex-wrap items-center justify-between gap-[var(--space-2)]">
                    <h3 className="m-0 text-[length:var(--tr-text-ui-size)] font-semibold">{item.title}</h3>
                    <Button size="sm">Run now</Button>
                  </div>
                  <div className="grid gap-[var(--space-2)] sm:grid-cols-2">
                    <div><Caption>Schedule</Caption><Segmented aria-label="Schedule" options={[{ value: 'manual', label: 'Manual' }, { value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }]} value="daily" /></div>
                    <div><Caption>Runs on</Caption><Select aria-label="Runs on" value="claude" options={[{ value: 'claude', label: 'Claude Code' }]} onChange={noop} /></div>
                  </div>
                  <SectionHead title="Runs" count={30} />
                  <Table variant="framed" aria-label="Routine run history" rows={[{ started: 'Today 02:00', result: 'Waiting for a slot', took: '—', cost: '—' }, { started: 'Yesterday 02:00', result: 'Done', took: '4m', cost: '$0.71' }, { started: 'Oct 1 02:00', result: 'Failed', took: '1m', cost: '$0.12' }]} getRowId={(row) => row.started} columns={[{ key: 'started', header: 'Started' }, { key: 'result', header: 'Result' }, { key: 'took', header: 'Took', numeric: true }, { key: 'cost', header: 'Cost', numeric: true }]} />
                  <Notice tone="warn">3 of 3 running. Routines run 3 at a time (Settings › Routines).</Notice>
                </div>
              )}
            />
          </PageFrame>
        </SpecimenGroup>

        <SpecimenGroup heading="Drawer — Tasks detail">
          <SpecimenRow><Button variant="secondary" onClick={() => setDrawerOpen(true)}>Open task detail</Button></SpecimenRow>
          <Drawer open={drawerOpen} heading="Task details" onClose={() => setDrawerOpen(false)} hideHeader tone="content">
            <div className="grid gap-[var(--space-3)]">
              <TaskDrawerHeader taskKey="HOU-42" workspace="houston" heading="Block bun test in agent settings" status="in_progress" actions={<Button variant="icon" icon={IconClose} aria-label="Close task details" onClick={() => setDrawerOpen(false)} />} />
              <TaskDrawerExecutionPanel tone="idle" status="Idle" metadata="Stopped 14m ago · Attempt 1 · Claude Code" reuse="Reuses houston/task/hou-42-bun-test · no pull request yet">
                <SpecimenRow><Button variant="secondary">Start again</Button><Button variant="secondary">Review changes</Button></SpecimenRow>
              </TaskDrawerExecutionPanel>
              <SectionHead title="Acceptance" count={2} />
              <TaskDrawerCard><TaskAcceptanceRow checked text="bun test is denied in .claude/settings.json" onToggle={noop} /><TaskAcceptanceRow checked={false} text="AGENTS.md points to bun run test" onToggle={noop} /></TaskDrawerCard>
            </div>
          </Drawer>
        </SpecimenGroup>

        <SpecimenGroup heading="Notice — Harness provider coverage">
          <Notice tone="info">Not read: 4 OpenCode sessions in this window.</Notice>
          <Notice tone="info" indicator="dot" action={{ label: 'Dismiss', onClick: noop }}>Review #13 found one new thing to fix and confirmed one fix worked.</Notice>
          <Notice tone="danger" action={{ label: 'Open settings', onClick: noop }}>Limits are unavailable until a quota reader is configured.</Notice>
        </SpecimenGroup>

        <SpecimenGroup heading="Tooltip">
          <SpecimenRow>
            <Tooltip label="Tooltip content"><Button autoFocus>Hover or focus</Button></Tooltip>
            <Tooltip label="Click also opens this tooltip." openOnClick><Button variant="icon" icon={IconCheck} aria-label="Open tooltip" /></Tooltip>
          </SpecimenRow>
        </SpecimenGroup>

        <SpecimenGroup heading="Chip">
          {(['state', 'provider', 'count', 'compound', 'removable'] as const).map((variant) => (
            <div key={variant} style={{ display: 'grid', gap: 'var(--space-2)' }}>
              <Caption>{variant}</Caption>
              <SpecimenRow>{(['default', 'info', 'success', 'warning', 'danger'] as const).map((tone) => (
                <Chip key={`${variant}-${tone}`} variant={variant} tone={tone} label={variant === 'compound' ? 'Claude · Done' : variant === 'provider' ? 'Claude Code' : 'Working'} count={variant === 'count' ? 8 : undefined} onClick={noop} onRemove={noop} />
              ))}</SpecimenRow>
            </div>
          ))}
          <SpecimenRow>
            <Chip variant="state" label="Selected" selected onClick={noop} />
            <Chip variant="state" label="Disabled" disabled disabledReason="Unavailable" onClick={noop} />
            <Chip variant="count" loading />
            <Chip variant="count" count={0} emptySetLabel="None" />
            <Chip variant="removable" label="Removable" onRemove={noop} />
          </SpecimenRow>
        </SpecimenGroup>

        <SpecimenGroup heading="IconTile">
          {(['sm', 'md', 'lg'] as const).map((size) => (
            <div key={size} style={{ display: 'grid', gap: 'var(--space-2)' }}>
              <Caption>{size}</Caption>
              <SpecimenRow>{(['default', 'accent', 'success', 'warning', 'danger', 'muted'] as const).map((tone) => (
                <IconTile key={`${size}-${tone}`} size={size} tone={tone} icon={<IconCheck role="ui" />} label={`${size} ${tone}`} />
              ))}</SpecimenRow>
            </div>
          ))}
          <SpecimenRow>
            <IconTile label="Selected tile" icon={<IconCheck role="ui" />} selected interactive onClick={noop} />
            <IconTile label="Disabled tile" icon={<IconClose role="ui" />} disabled disabledReason="Unavailable" interactive />
            <IconTile label="Loading tile" loading interactive />
            <IconTile label="Placeholder tile" />
          </SpecimenRow>
        </SpecimenGroup>
      </div>
    </div>
  )
}
