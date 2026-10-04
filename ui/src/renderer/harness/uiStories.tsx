import React, { useState } from 'react'
import {
  Button,
  Card,
  Chip,
  Count,
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
  Table,
  Tooltip
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

function Group({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section style={{ display: 'grid', gap: 'var(--space-3)' }}>
      <h2 style={{ margin: 0, color: 'var(--text-primary)', fontSize: 'var(--tr-text-heading-size)' }}>{title}</h2>
      {children}
    </section>
  )
}

function Row({ children }: { children: React.ReactNode }): React.JSX.Element {
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

        <Group title="Button">
          <Row>
            <Button variant="primary" icon={IconPlus}>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger">Danger</Button>
            <Button variant="danger" armed icon={IconAlertTriangle}>Armed</Button>
            <Button variant="danger-solid" icon={IconAlertTriangle}>Danger solid</Button>
            <Button variant="icon" icon={IconClose} aria-label="Close" />
          </Row>
          <Row>
            <Button variant="primary" size="sm">Primary small</Button>
            <Button variant="secondary" size="sm">Secondary small</Button>
            <Button variant="ghost" size="sm">Ghost small</Button>
            <Button variant="danger" size="sm">Danger small</Button>
            <Button variant="danger-solid" size="sm" icon={IconAlertTriangle}>Danger small</Button>
          </Row>
          <Row>
            <Button variant="primary" disabled>Disabled primary</Button>
            <Button variant="secondary" disabled>Disabled secondary</Button>
            <Button variant="ghost" disabled>Disabled ghost</Button>
            <Button variant="danger" disabled>Disabled danger</Button>
            <Button variant="icon" icon={IconClose} aria-label="Disabled close" disabled />
          </Row>
        </Group>

        <Group title="Card and Card.Row">
          <Card>
            <Card.Row heading="Default card" meta="Heading and supporting detail" status={<StatusLabel status="Working" />} action={<Button size="sm">Open</Button>} />
            <Card.Row heading="Second row" meta="Rows keep their shared structure" />
          </Card>
          <Card tone="inset"><Card.Row heading="Inset card" meta="Alternate surface tone" /></Card>
        </Group>

        <Group title="Count">
          <Row><span>Tasks<Count value={12} /></span><span>Zero omitted<Count value={0} /></span><span>Zero shown<Count value={0} showZero /></span></Row>
          <Row><span>Primary ink<Count value={4} from="primary" /></span><span>Secondary ink<Count value={4} from="secondary" /></span></Row>
        </Group>

        <Group title="StatusLabel">
          <Row>{STATUS_LABELS.map((status) => <StatusLabel key={status} status={status} />)}</Row>
        </Group>

        <Group title="PageFrame, PageHeader and SectionHead">
          <PageFrame width="form" style={{ border: '1px dashed var(--border)' }}>
            <PageHeader heading="Form width" description="A one sentence description." count={3} actions={<Button variant="primary" icon={IconPlus}>New item</Button>} />
            <SectionHead title="Section" count={2} action={<Button variant="ghost" size="sm">View all</Button>} />
          </PageFrame>
          <PageFrame width="wide" style={{ border: '1px dashed var(--border)' }}>
            <PageHeader heading="Wide width" />
            <SectionHead title="Empty count" count={0} />
          </PageFrame>
        </Group>

        <Group title="Field">
          <div style={{ display: 'grid', gap: 'var(--space-3)', maxWidth: 420 }}>
            <Field label="Workspace" hint="Choose a project folder."><input value="/home/dev/code/houston" readOnly /></Field>
            <Field label="Required field" error="A value is required."><input value="" readOnly aria-invalid="true" /></Field>
            <Field label="Disabled field" hint="This value is managed elsewhere."><input value="Managed" readOnly disabled /></Field>
          </div>
        </Group>

        <Group title="EmptyState">
          <Row>
            <div style={{ flex: '1 1 360px', padding: 24, border: '1px solid var(--divider)' }}>
              <EmptyState icon={IconSearch} heading="No results" description="Try a different search." action={{ label: 'Clear search', onClick: noop }} />
            </div>
            <div style={{ flex: '1 1 360px', padding: 24, border: '1px solid var(--divider)' }}>
              <EmptyState icon={IconPlus} heading="No workspace" description="Choose a workspace to get started." variant="window" />
            </div>
          </Row>
        </Group>

        <Group title="PaneHeaderButton">
          <Row><PaneHeaderButton icon={IconClose} aria-label="Close pane" /><PaneHeaderButton icon={IconPlus} aria-label="Add pane" /><PaneHeaderButton icon={IconClose} aria-label="Disabled close pane" disabled /></Row>
        </Group>

        <Group title="Select">
          <Row>
            <Select value="graphite" options={options} onChange={noop} aria-label="Theme" />
            <Select value="paper" options={options} onChange={noop} aria-label="Disabled theme" disabled />
          </Row>
        </Group>

        <Group title="Segmented">
          <Row>
            <Segmented aria-label="Filter" options={[{ value: 'active', label: 'Active' }, { value: 'resolved', label: 'Resolved' }, { value: 'dismissed', label: 'Dismissed' }]} value="active" onChange={noop} />
            <Segmented aria-label="Disabled choice" options={[{ value: 'one', label: 'One' }, { value: 'two', label: 'Two', disabled: true }]} value="two" />
            <Segmented aria-label="Loading choice" options={[{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }]} value="one" loading />
          </Row>
          <Segmented aria-label="Error choice" options={[]} error={{ message: 'Could not load options.', onRetry: noop }} />
        </Group>

        <Group title="Table — Usage breakdown">
          <Table
            aria-label="Usage breakdown by model"
            rows={breakdownRows}
            getRowId={(row) => row.model}
            columns={[
              { key: 'rank', header: '#' },
              { key: 'model', header: 'Model', render: (value, row) => (
                <span className="grid gap-[var(--space-1)] text-[var(--text-primary)]">
                  <span className="underline decoration-[var(--text-muted)] underline-offset-[var(--space-1)]">{value}</span>
                  <span aria-hidden="true" className="h-px max-w-full bg-[var(--text-muted)]" style={{ width: `${row.bar}%` }} />
                </span>
              ) },
              { key: 'cost', header: 'Cost', numeric: true },
              { key: 'share', header: 'Share', numeric: true },
              { key: 'tokens', header: 'Tokens', numeric: true }
            ]}
          />
        </Group>

        <Group title="ListDetail — Routines">
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
                  <Table aria-label="Routine run history" rows={[{ started: 'Today 02:00', result: 'Waiting for a slot', took: '—', cost: '—' }, { started: 'Yesterday 02:00', result: 'Done', took: '4m', cost: '$0.71' }, { started: 'Oct 1 02:00', result: 'Failed', took: '1m', cost: '$0.12' }]} getRowId={(row) => row.started} columns={[{ key: 'started', header: 'Started' }, { key: 'result', header: 'Result' }, { key: 'took', header: 'Took', numeric: true }, { key: 'cost', header: 'Cost', numeric: true }]} />
                  <Notice tone="warn">3 of 3 running. Routines run 3 at a time (Settings › Routines).</Notice>
                </div>
              )}
            />
          </PageFrame>
        </Group>

        <Group title="Drawer — Tasks detail">
          <Row><Button variant="secondary" onClick={() => setDrawerOpen(true)}>Open task detail</Button></Row>
          <Drawer open={drawerOpen} title="Block bun test in agent settings" onClose={() => setDrawerOpen(false)}>
            <div className="grid gap-[var(--space-3)]">
              <Caption>HOU-42 · houston</Caption>
              <p className="m-0 text-[length:var(--tr-text-ui-size)] text-[var(--text-secondary)]">Idle · stopped 14m ago · Attempt 1 · Claude Code</p>
              <Row><Button>Start again</Button><Button variant="secondary">Review changes</Button></Row>
              <SectionHead title="Acceptance" count={2} />
              <Card><Card.Row heading="bun test is denied in .claude/settings.json" /><Card.Row heading="AGENTS.md points to bun run test" /></Card>
            </div>
          </Drawer>
        </Group>

        <Group title="Notice — Harness provider coverage">
          <Notice tone="info">Not read: 4 OpenCode sessions in this window.</Notice>
          <Notice tone="danger" action={{ label: 'Open settings', onClick: noop }}>Limits are unavailable until a quota reader is configured.</Notice>
        </Group>

        <Group title="Tooltip">
          <Row>
            <Tooltip label="Tooltip content"><Button autoFocus>Hover or focus</Button></Tooltip>
            <Tooltip label="Click also opens this tooltip." openOnClick><Button variant="icon" icon={IconCheck} aria-label="Open tooltip" /></Tooltip>
          </Row>
        </Group>

        <Group title="Chip">
          {(['state', 'provider', 'count', 'compound', 'removable'] as const).map((variant) => (
            <div key={variant} style={{ display: 'grid', gap: 'var(--space-2)' }}>
              <Caption>{variant}</Caption>
              <Row>{(['default', 'info', 'success', 'warning', 'danger'] as const).map((tone) => (
                <Chip key={`${variant}-${tone}`} variant={variant} tone={tone} label={variant === 'compound' ? 'Claude · Done' : variant === 'provider' ? 'Claude Code' : 'Working'} count={variant === 'count' ? 8 : undefined} onClick={noop} onRemove={noop} />
              ))}</Row>
            </div>
          ))}
          <Row>
            <Chip variant="state" label="Selected" selected onClick={noop} />
            <Chip variant="state" label="Disabled" disabled disabledReason="Unavailable" onClick={noop} />
            <Chip variant="count" loading />
            <Chip variant="count" count={0} emptySetLabel="None" />
            <Chip variant="removable" label="Removable" onRemove={noop} />
          </Row>
        </Group>

        <Group title="IconTile">
          {(['sm', 'md', 'lg'] as const).map((size) => (
            <div key={size} style={{ display: 'grid', gap: 'var(--space-2)' }}>
              <Caption>{size}</Caption>
              <Row>{(['default', 'accent', 'success', 'warning', 'danger', 'muted'] as const).map((tone) => (
                <IconTile key={`${size}-${tone}`} size={size} tone={tone} icon={<IconCheck role="ui" />} label={`${size} ${tone}`} />
              ))}</Row>
            </div>
          ))}
          <Row>
            <IconTile label="Selected tile" icon={<IconCheck role="ui" />} selected interactive onClick={noop} />
            <IconTile label="Disabled tile" icon={<IconClose role="ui" />} disabled disabledReason="Unavailable" interactive />
            <IconTile label="Loading tile" loading interactive />
            <IconTile label="Placeholder tile" />
          </Row>
        </Group>
      </div>
    </div>
  )
}
