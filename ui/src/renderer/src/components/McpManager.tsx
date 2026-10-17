import { SettingsDisclosure } from './ui/SettingsDisclosure'
import { AgentConnectionGrid, AgentConnectionTile } from './ui/AgentConnectionTile'
import { ProviderGlyphTile } from './ui/AgentCliRow'
import { SetupDot } from './ui/AgentSetupRow'
import { SettingsToolbar } from './ui/SettingsToolbar'
import { SettingsButton } from './ui/SettingsButtonRoles'
import { useState } from 'react'
import {
  IconPlus,
  IconRefresh,
  IconServer,
  IconTrash
} from './icons'
import { ConfirmModal } from './ConfirmModal'
import type { AgentKind } from '../houston/generated/AgentKind'
import type { McpConnectionCheck } from '../houston/generated/McpConnectionCheck'
import type { McpServer } from '../houston/generated/McpServer'
import type { McpSyncResult } from '../houston/generated/McpSyncResult'
import type { McpToolState } from '../houston/generated/McpToolState'
import type { HoustonClient } from '../houston/client'
import type { McpTransport } from '../houston/generated/McpTransport'
import { buildRows, cellFor, maskSecret, type MatrixRow } from '../houston/mcpRows'
import { Icon } from './ui/Icon'
import { Button, Caption, Card, ConnectionCell, Drawer, PageHeader, Notice, Table, Text, TextInput, FieldLabel, Chip, ChoiceGroup, ConfigurationDetail, Segmented, ResultList, ResultRow, Footnote, type TableColumn } from './ui'
import { Switch } from './ui/Switch'
import { ActionMenu } from './ui/ActionMenu'
import { TASK_AGENTS } from './tasks/format'
import { ConnectionsIntegrations } from './ConnectionsIntegrations'
import { AgentSettingsBody } from './ui/AgentSettingsBody'

const TOOL_LABEL: Partial<Record<AgentKind, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
  zcode: 'ZCode'
}

function McpConnectionsView({ props, rows }: { props: McpManagerProps; rows: MatrixRow[] }): React.JSX.Element {
  const [form, setForm] = useState<{ previousName: string | null } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [diffRow, setDiffRow] = useState<string | null>(null)
  const listed = rows.filter((row) => row.source !== null)

  const toggleCell = (row: MatrixRow, tool: AgentKind): void => {
    const source = row.source
    if (!source) return
    const allowed = source.destinations.length > 0 ? source.destinations : DESTINATIONS
    const current = cellFor(row, tool)
    const destinations = !source.enabled
      ? allowed
      : (current.kind === 'disabled' || current.kind === 'absent') && allowed.includes(tool)
        ? allowed
        : allowed.includes(tool)
          ? allowed.filter((destination) => destination !== tool)
          : [...allowed, tool]
    props.onUpsertServer(row.name, { ...source, enabled: true, destinations })
    props.onSync(tool)
  }

  const cell = (row: MatrixRow, tool: AgentKind): React.ReactNode => {
    const toolState = props.tools.find((item) => item.tool === tool)
    const syncResult = props.results.find((result) => result.tool === tool)
    const current = cellFor(row, tool)
    const reason = toolState?.error ?? syncResult?.error ?? undefined
    const status = reason
      ? 'Failed'
      : current.kind === 'drifted' && row.source && row.byTool[tool]?.fingerprint !== row.source.fingerprint
        ? 'Differs'
        : current.kind === 'in-sync' || (current.kind === 'drifted' && row.source && row.byTool[tool]?.fingerprint === row.source.fingerprint)
          ? 'In sync'
          : 'Off'
    return <ConnectionCell status={status} reason={reason} server={row.name} agent={label(tool)} data-testid={`mcp-cell-${tool}-${row.name}`} onClick={() => toggleCell(row, tool)} />
  }

  const displayRows: ConnectionDisplayRow[] = listed.map((row) => ({
    id: row.name,
    name: row.name,
    claude: cell(row, 'claude'),
    codex: cell(row, 'codex'),
    opencode: cell(row, 'opencode')
  }))
  const columns: TableColumn<ConnectionDisplayRow>[] = [
    { key: 'name', header: 'Server', width: '18%', render: (name) => <strong>{name}</strong> },
    { key: 'claude', header: 'Claude Code', width: '16%', render: (value) => value },
    { key: 'codex', header: 'Codex', width: '16%', render: (value) => value },
    { key: 'opencode', header: 'OpenCode', width: '16%', render: (value) => value }
  ]
  const selectedDiff = diffRow ? rows.find((row) => row.name === diffRow) : undefined
  const unmanaged = TASK_AGENTS.filter((agent) => !DESTINATIONS.includes(agent)).reverse().map(label).join(', ')

  if (!props.loaded) {
    return <AgentSettingsBody embedded={props.embedded} data-testid="mcp-manager"><PageHeader heading="MCP servers" description="MCP servers your agents can use. Houston writes them into each agent's own config." /><p role="status">Opening servers…</p>{!props.embedded && props.slackClient && <ConnectionsIntegrations client={props.slackClient} />}</AgentSettingsBody>
  }

  return (
    <AgentSettingsBody embedded={props.embedded} data-testid="mcp-manager">
      <PageHeader
        heading="MCP servers"
        description="MCP servers your agents can use. Houston writes them into each agent's own config."
        actions={props.embedded ? undefined : <Button variant="primary" icon={IconPlus} onClick={() => setForm({ previousName: null })}>Add server</Button>}
      />
      {props.embedded ? <SettingsMcpList onAdd={() => setForm({ previousName: null })} props={props} rows={listed} onToggle={toggleCell} onEdit={(name) => setForm({ previousName: name })} onDiff={setDiffRow} onRemove={setConfirmRemove} /> : <>
      {listed.map((row) => {
        const check = checkFor(row.name, props.checks)
        return check.state === 'failed' ? <Notice key={row.name} tone="danger" action={{ label: 'Check again', onClick: () => props.onTest(row.name) }}>Houston can&apos;t start {row.name}: {check.message}</Notice> : null
      })}
      <Table
        aria-label="MCP server connections"
        variant="card"
        layout="fixed"
        rows={displayRows}
        getRowId={(row) => row.id}
        columns={columns}
        rowAction={(display) => {
          const row = rows.find((item) => item.name === display.id)!
          const failed = DESTINATIONS.some((tool) => cellFor(row, tool).kind !== 'absent' && checkFor(row.name, props.checks).state === 'failed') || DESTINATIONS.some((tool) => props.tools.find((item) => item.tool === tool)?.error)
          const label = row.hasDrift ? 'Show diff' : failed ? 'Edit' : null
          const items = [
            ...(row.hasDrift ? [{ label: diffRow === row.name ? 'Hide diff' : 'Show diff', onSelect: () => setDiffRow(diffRow === row.name ? null : row.name) }] : []),
            ...(!row.hasDrift ? [{ label: 'Edit', onSelect: () => setForm({ previousName: row.name }) }] : []),
            { label: 'Remove', onSelect: () => setConfirmRemove(row.name), tone: 'danger' as const }
          ]
          return label
            ? <Button variant="secondary" size="sm" onClick={() => row.hasDrift ? setDiffRow(diffRow === row.name ? null : row.name) : setForm({ previousName: row.name })}>{label}</Button>
            : <ActionMenu label={`More actions for ${row.name}`} iconOnly items={items} />
        }}
        empty={{ icon: IconServer, heading: 'No MCP servers', description: 'Add an MCP server to connect it to your agents.' }}
      />

      </>}
      <McpDifference row={selectedDiff} />
      <Caption tone="faint">Not managed here: {unmanaged}.{listed.length > 0 && !props.embedded ? ' Click a cell to turn a server on or off for that agent.' : ''}</Caption>
      {!props.embedded && props.slackClient && <ConnectionsIntegrations client={props.slackClient} />}
      <Drawer open={form !== null} heading={form?.previousName ? `Edit ${form.previousName}` : 'Add server'} onClose={() => setForm(null)}>
        {form && <McpServerForm
          previousName={form.previousName}
          initial={form.previousName ? formFromServer(props.source.find((server) => server.name === form.previousName) ?? emptyFormServer()) : emptyForm()}
          existingNames={props.source.map((server) => server.name)}
          results={props.results}
          onCancel={() => setForm(null)}
          onSubmit={(server) => { props.onUpsertServer(form.previousName, server); props.onSync(null); setForm(null) }}
        />}
      </Drawer>
      {confirmRemove && <ConfirmModal title="REMOVE SERVER" message={`Remove ${confirmRemove} from your list and every tool it was applied to?`} confirmLabel="Remove" onCancel={() => setConfirmRemove(null)} onConfirm={() => { props.onRemoveServer(confirmRemove); props.onSync(null); setConfirmRemove(null) }} />}
    </AgentSettingsBody>
  )
}

function McpDifference({ row }: { row: MatrixRow | undefined }): React.JSX.Element | null {
  if (!row?.source) return null
  return <section aria-label={`${row.name} configuration differences`}><Card padding="sm" className="grid gap-[var(--space-2)]"><DetailCard title="Houston's list" server={row.source} />{DESTINATIONS.filter((tool) => row.byTool[tool] && row.byTool[tool]!.fingerprint !== row.source!.fingerprint).map((tool) => <DetailCard key={tool} title={label(tool)} server={row.byTool[tool]!} />)}</Card></section>
}

function mcpRowStatus(row: MatrixRow, check: McpConnectionCheck): { label: string; tone: 'danger' | 'warn' | 'ok' | 'muted' } {
  if (check.state === 'failed') return { label: "Can't start", tone: 'danger' }
  const edited = DESTINATIONS.find((tool) => row.byTool[tool] && row.byTool[tool]!.fingerprint !== row.source?.fingerprint)
  if (edited) return { label: `${label(edited)} has an edited copy`, tone: 'warn' }
  const count = DESTINATIONS.filter((tool) => row.byTool[tool]?.enabled).length
  return { label: `${count} configured · ${check.state === 'verified' ? 'Tested' : check.state === 'checking' ? 'Checking' : 'Not checked'}`, tone: check.state === 'verified' ? 'ok' : 'muted' }
}
function SettingsMcpList({ props, rows, onAdd, onToggle, onEdit, onDiff, onRemove }: { props: McpManagerProps; rows: MatrixRow[]; onAdd: () => void; onToggle: (row: MatrixRow, tool: AgentKind) => void; onEdit: (name: string) => void; onDiff: (name: string) => void; onRemove: (name: string) => void }): React.JSX.Element {
  const [filter, setFilter] = useState<'all' | 'configured' | 'problems'>('all')
  const matches = (row: MatrixRow, value: typeof filter): boolean => value === 'all' || (value === 'problems' ? row.hasDrift || checkFor(row.name, props.checks).state === 'failed' : DESTINATIONS.some((tool) => row.byTool[tool]?.enabled))
  const visible = rows.filter((row) => matches(row, filter))
  const count = (value: typeof filter): number => rows.filter((row) => matches(row, value)).length
  return <div className="grid gap-[var(--space-3)]"><SettingsToolbar actions={<><Button variant="ghost" icon={IconRefresh} aria-label="Check all servers" onClick={() => { props.onRefresh(); rows.forEach((row) => props.onTest(row.name)) }}>Check again</Button><Button variant="primary" icon={IconPlus} onClick={onAdd}>Add server</Button></>}><Segmented aria-label="Filter servers" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All', count: count('all') }, { value: 'configured', label: 'Configured', count: count('configured') }, { value: 'problems', label: 'Problems', count: count('problems') }]} /></SettingsToolbar><Card shape="card">{visible.map((row) => <SettingsMcpServer key={row.name} row={row} props={props} onToggle={onToggle} onEdit={onEdit} onDiff={onDiff} onRemove={onRemove} />)}{!visible.length && <Card.Row heading="No MCP servers" meta="Add an MCP server to connect it to your agents." />}</Card></div>
}
function SettingsMcpServer({ row, props, onToggle, onEdit, onDiff, onRemove }: { row: MatrixRow } & Omit<React.ComponentProps<typeof SettingsMcpList>, 'rows' | 'onAdd'>): React.JSX.Element {
  const check = checkFor(row.name, props.checks)
  const status = mcpRowStatus(row, check)
  const source = row.source!
  const command = source.transport === 'stdio' ? [source.command, ...source.args].join(' ') : source.url
  return <SettingsDisclosure heading={row.name} detail={<Text mono>{command}</Text>} open={check.state === 'failed'} status={<span className="flex items-center gap-[var(--space-3)]"><span className="flex items-center gap-[var(--space-1)]">{DESTINATIONS.map((tool) => <ProviderGlyphTile key={tool} agent={tool} state={!row.byTool[tool]?.enabled ? 'off' : row.byTool[tool]?.fingerprint !== source.fingerprint ? 'differs' : 'on'} />)}</span><span className="flex items-center gap-[var(--space-1-5)]"><SetupDot tone={status.tone} /><Text size="small" tone={status.tone}>{status.label}</Text></span></span>}>
    {check.state === 'failed' && <Notice tone="danger" detail={startGuidance(source, check.message)} secondaryAction={{ label: 'Edit command', onClick: () => onEdit(row.name) }} action={{ label: 'Check again', onClick: () => props.onTest(row.name) }}>Houston can&apos;t start {row.name}: {check.message}</Notice>}
    <AgentConnectionGrid>{DESTINATIONS.map((tool) => { const current = cellFor(row, tool); const reason = props.tools.find((item) => item.tool === tool)?.error ?? props.results.find((item) => item.tool === tool)?.error ?? undefined; return <AgentConnectionTile key={tool} agent={tool} label={label(tool)} server={row.name} checked={current.kind !== 'absent' && current.kind !== 'disabled'} status={reason ? 'Failed' : current.kind === 'absent' || current.kind === 'disabled' ? 'Off' : row.byTool[tool]?.fingerprint !== source.fingerprint ? 'Differs' : 'On'} reason={reason} onChange={() => onToggle(row, tool)} testId={`mcp-cell-${tool}-${row.name}`} /> })}</AgentConnectionGrid>
    <SettingsToolbar actions={<Button variant="body-link" onClick={() => onRemove(row.name)}>Remove server…</Button>}><Text size="small" tone="muted">Written to each agent's own config, inside a managed block.</Text>{check.state !== 'failed' && <Button variant="body-link" onClick={() => onEdit(row.name)}>Edit command</Button>}<Button variant="body-link" onClick={() => onDiff(row.name)}>Show what Houston writes</Button></SettingsToolbar>
  </SettingsDisclosure>
}

const NODE_COMMANDS = new Set(['npx', 'node', 'npm', 'pnpm', 'bunx'])
function startGuidance(server: McpServer, message: string): string | null {
  if (server.transport !== 'stdio' || !server.command || !/not found|PATH/i.test(message)) return null
  const command = server.command
  const install = NODE_COMMANDS.has(command) ? 'Node.js' : command
  const example = command.startsWith('/') ? command : `/usr/local/bin/${command}`
  return `Houston runs the command from your login shell. Install ${install}, or give the command an absolute path such as ${example}.`
}

function emptyFormServer(): McpServer {
  return { name: '', transport: 'stdio', command: null, args: [], env: [], url: null, headers: [], cwd: null, enabled: true, fingerprint: '', destinations: [] }
}

function label(tool: AgentKind): string {
  return TOOL_LABEL[tool] ?? tool
}

const DESTINATIONS: AgentKind[] = ['claude', 'codex', 'opencode']

interface ConnectionDisplayRow {
  id: string
  name: string
  claude: React.ReactNode
  codex: React.ReactNode
  opencode: React.ReactNode
}

function destinationsLabel(destinations: AgentKind[]): string {
  if (destinations.length === 0) return 'All tools'
  return destinations.map(label).join(', ')
}

function checkFor(name: string, checks: Array<[string, McpConnectionCheck]>): McpConnectionCheck {
  return checks.find(([n]) => n === name)?.[1] ?? { state: 'not_checked' }
}

function DetailCard({ title, server }: { title: string; server: McpServer }): React.JSX.Element {
  const rows: Array<[string, string]> = [['transport', server.transport]]
  if (server.command) rows.push(['command', [server.command, ...server.args].join(' ')])
  if (server.url) rows.push(['url', server.url])
  if (server.cwd) rows.push(['cwd', server.cwd])
  if (server.env.length > 0) {
    rows.push(['env', server.env.map(([k, v]) => `${k}=${maskSecret(v)}`).join(' ')])
  }
  if (server.headers.length > 0) {
    rows.push(['headers', server.headers.map(([k, v]) => `${k}: ${maskSecret(v)}`).join('  ')])
  }
  return <ConfigurationDetail title={title} fingerprint={server.fingerprint} rows={rows.map(([label, value]) => ({ label, value }))} />
}

function PairListEditor({
  legend,
  pairs,
  onChange,
  keyPlaceholder
}: {
  legend: string
  pairs: Array<[string, string]>
  onChange: (pairs: Array<[string, string]>) => void
  keyPlaceholder: string
}): React.JSX.Element {
  return (
    <div className="grid gap-[var(--space-field-label-bottom)]">
      <FieldLabel size="form">{legend}</FieldLabel>
      <div className="grid gap-[var(--space-1-5)]">
        {pairs.map(([k, v], i) => (
          <div key={i} className="flex items-center gap-[var(--space-1-5)]">
            <TextInput size="form" surface="card"
              placeholder={keyPlaceholder}
              value={k}
              onChange={(e) => {
                const next = [...pairs]
                next[i] = [e.target.value, v]
                onChange(next)
              }}
            />
            <TextInput size="form" surface="card"
              placeholder="value"
              value={v}
              onChange={(e) => {
                const next = [...pairs]
                next[i] = [k, e.target.value]
                onChange(next)
              }}
            />
            <SettingsButton
              variant="compact-icon-danger"
              aria-label={`remove ${legend.toLowerCase()} row ${i + 1}`}
              onClick={() => onChange(pairs.filter((_, j) => j !== i))}
            >
              <Icon glyph={IconTrash} role="small" />
            </SettingsButton>
          </div>
        ))}
        <SettingsButton
          variant="compact-secondary"
          className="justify-self-start"
          onClick={() => onChange([...pairs, ['', '']])}
        >
          <Icon glyph={IconPlus} role="small" />
          Add
        </SettingsButton>
      </div>
    </div>
  )
}

function ArgListEditor({
  args,
  onChange
}: {
  args: string[]
  onChange: (args: string[]) => void
}): React.JSX.Element {
  return (
    <div className="grid gap-[var(--space-1)]">
      <div className="grid gap-[var(--space-form-label-control-gap)]">
        <FieldLabel size="form">Arguments</FieldLabel>
        <div className="grid gap-[var(--space-1-5)]">
        {args.map((a, i) => (
          <div key={i} className="flex items-center gap-[var(--space-1-5)]">
            <TextInput size="form" surface="card"
              aria-label={`argument ${i + 1}`}
              placeholder="-y"
              value={a}
              onChange={(e) => {
                const next = [...args]
                next[i] = e.target.value
                onChange(next)
              }}
            />
            <SettingsButton
              variant="compact-icon-danger"
              aria-label={`remove argument ${i + 1}`}
              onClick={() => onChange(args.filter((_, j) => j !== i))}
            >
              <Icon glyph={IconTrash} role="small" />
            </SettingsButton>
          </div>
        ))}
        <SettingsButton
          variant="compact-secondary"
          className="justify-self-start"
          onClick={() => onChange([...args, ''])}
        >
          <Icon glyph={IconPlus} role="small" />
          Add argument
        </SettingsButton>
        </div>
      </div>
      <Text as="p" size="small" tone="faint">
        One field per argument, in order — an embedded space is kept exactly as typed.
      </Text>
    </div>
  )
}

interface FormValue {
  name: string
  transport: McpTransport
  command: string
  args: string[]
  url: string
  cwd: string
  env: Array<[string, string]>
  headers: Array<[string, string]>
  enabled: boolean
  destinations: AgentKind[]
}

function emptyForm(): FormValue {
  return {
    name: '',
    transport: 'stdio',
    command: '',
    args: [],
    url: '',
    cwd: '',
    env: [],
    headers: [],
    enabled: true,
    destinations: []
  }
}

function formFromServer(server: McpServer): FormValue {
  return {
    name: server.name,
    transport: server.transport,
    command: server.command ?? '',
    args: server.args,
    url: server.url ?? '',
    cwd: server.cwd ?? '',
    env: server.env,
    headers: server.headers,
    enabled: server.enabled,
    destinations: server.destinations
  }
}

function formIsValid(v: FormValue): boolean {
  if (v.name.trim().length === 0) return false
  return v.transport === 'stdio' ? v.command.trim().length > 0 : v.url.trim().length > 0
}

function serverFromForm(v: FormValue): McpServer {
  return {
    name: v.name.trim(),
    transport: v.transport,
    command: v.transport === 'stdio' ? v.command.trim() : null,
    args: v.transport === 'stdio' ? v.args.filter((a) => a.length > 0) : [],
    env: v.env.filter(([k]) => k.trim().length > 0),
    url: v.transport === 'stdio' ? null : v.url.trim(),
    headers: v.transport === 'stdio' ? [] : v.headers.filter(([k]) => k.trim().length > 0),
    cwd: v.transport === 'stdio' && v.cwd.trim().length > 0 ? v.cwd.trim() : null,
    enabled: v.enabled,
    fingerprint: '',
    destinations: v.destinations
  }
}

const TRANSPORT_OPTIONS = [
  { value: 'stdio' as const, label: 'Command' },
  { value: 'http' as const, label: 'URL (HTTP)' },
  { value: 'sse' as const, label: 'URL (SSE)' }
]

function McpServerForm({
  previousName,
  initial,
  existingNames,
  results,
  onCancel,
  onSubmit
}: {
  previousName: string | null
  initial: FormValue
  existingNames: string[]
  results: McpSyncResult[]
  onCancel: () => void
  onSubmit: (server: McpServer) => void
}): React.JSX.Element {
  const [value, setValue] = useState(initial)
  const nameTaken =
    value.name.trim().length > 0 &&
    value.name.trim() !== previousName &&
    existingNames.includes(value.name.trim())
  const valid = formIsValid(value) && !nameTaken

  return (
    <>
          <Text as="h2" size="subhead" weight="semibold" tone="primary" flush>
            {previousName ? `Edit ${previousName}` : 'Add server'}
          </Text>
          <div className="grid gap-[var(--space-1)]">
            <div className="grid gap-[var(--space-form-label-control-gap)]">
              <FieldLabel as="label" size="form" htmlFor="mcp-form-name">
                Name
              </FieldLabel>
              <TextInput size="form" surface="card"
                id="mcp-form-name"
                value={value.name}
                onChange={(e) => setValue({ ...value, name: e.target.value })}
                placeholder="context7"
                aria-invalid={nameTaken || undefined}
              />
            </div>
            {nameTaken && (
              <Text as="p" size="small" tone="danger">
                {value.name.trim()} is already the name of another server in your list.
              </Text>
            )}
          </div>

          <div className="grid justify-items-start gap-[var(--space-field-label-bottom)]">
            <FieldLabel size="form">Reached by</FieldLabel>
            <Segmented
              aria-label="Transport"
              options={TRANSPORT_OPTIONS}
              value={value.transport}
              onChange={(transport) => setValue({ ...value, transport })}
            />
          </div>

          {value.transport === 'stdio' ? (
            <>
              <div className="grid gap-[var(--space-field-label-bottom)]">
                <FieldLabel as="label" size="form" htmlFor="mcp-form-command">
                  Command
                </FieldLabel>
                <TextInput size="form" surface="card"
                  id="mcp-form-command"
                  value={value.command}
                  onChange={(e) => setValue({ ...value, command: e.target.value })}
                  placeholder="npx"
                />
              </div>
              <ArgListEditor
                args={value.args}
                onChange={(args) => setValue({ ...value, args })}
              />
              <div className="grid gap-[var(--space-field-label-bottom)]">
                <FieldLabel as="label" size="form" htmlFor="mcp-form-cwd">
                  Working directory <Text tone="faint">(optional)</Text>
                </FieldLabel>
                <TextInput size="form" surface="card"
                  id="mcp-form-cwd"
                  value={value.cwd}
                  onChange={(e) => setValue({ ...value, cwd: e.target.value })}
                  placeholder="/home/you/project"
                />
              </div>
            </>
          ) : (
            <div className="grid gap-[var(--space-field-label-bottom)]">
              <FieldLabel as="label" size="form" htmlFor="mcp-form-url">
                URL
              </FieldLabel>
              <TextInput size="form" surface="card"
                id="mcp-form-url"
                value={value.url}
                onChange={(e) => setValue({ ...value, url: e.target.value })}
                placeholder="https://example.com/mcp"
              />
            </div>
          )}

          <PairListEditor
            legend="Environment"
            pairs={value.env}
            onChange={(env) => setValue({ ...value, env })}
            keyPlaceholder="NAME"
          />
          {value.transport !== 'stdio' && (
            <PairListEditor
              legend="Headers"
              pairs={value.headers}
              onChange={(headers) => setValue({ ...value, headers })}
              keyPlaceholder="Authorization"
            />
          )}
          <Text as="p" size="small" tone="faint">
            A value starting with <code>$</code> or <code>${'{'}NAME{'}'}</code> is kept as a
            reference to an environment variable, never stored as the secret itself; the detail
            view masks anything else.
          </Text>

          <div className="grid gap-[var(--space-1-5)]">
            <div className="grid gap-[var(--space-form-choice-label-gap)]">
              <FieldLabel size="form">Destinations</FieldLabel>
              <ChoiceGroup>
              {DESTINATIONS.map((tool) => {
                const on = value.destinations.includes(tool)
                return (
                  <Chip
                    key={tool}
                    variant="choice"
                    label={label(tool)}
                    selected={on}
                    onClick={() =>
                      setValue({
                        ...value,
                        destinations: on
                          ? value.destinations.filter((t) => t !== tool)
                          : [...value.destinations, tool]
                      })
                    }
                  />
                )
              })}
              </ChoiceGroup>
            </div>
            <Text as="p" size="small" tone="faint">
              {value.destinations.length === 0
                ? 'Nothing selected — this server goes to every tool.'
                : `Saving applies it to exactly these: ${destinationsLabel(value.destinations)}.`}
            </Text>
          </div>

          <label className="flex items-center gap-[var(--space-2)]">
            <Switch size="configuration"
              on={value.enabled}
              label={value.enabled ? 'Turn this server off' : 'Turn this server on'}
              onChange={(enabled) => setValue({ ...value, enabled })}
            />
            <Text size="ui" tone="primary">Enabled</Text>
          </label>

          {results.length > 0 && (
              <div className="grid gap-[var(--space-field-label-bottom)]">
              <FieldLabel size="form">Applied to</FieldLabel>
              <ResultList>
                {results.map((r) => (
                  <ResultRow key={r.tool}>
                    <div className="min-w-0 flex-1 grid gap-[var(--space-result-copy-gap)]">
                      <Text as="strong" size="ui" weight="semibold" leading="snug" tone="primary">{label(r.tool)}</Text>
                      {r.error ? (
                        <Text size="small" tone="danger">
                          {r.error}
                        </Text>
                      ) : r.skipped.length > 0 ? (
                        r.skipped.map((s) => (
                          <Text as="div" key={s} size="small" tone="warn">
                            {s}
                          </Text>
                        ))
                      ) : (
                        <Text as="div" size="small" tone="secondary">
                          Wrote {r.written}, removed {r.removed}
                        </Text>
                      )}
                    </div>
                  </ResultRow>
                ))}
              </ResultList>
            </div>
          )}

          <div className="flex items-center gap-[var(--space-2)]">
            <SettingsButton variant="compact-secondary" onClick={onCancel}>
              Cancel
            </SettingsButton>
            <SettingsButton
              variant="compact-primary"
              disabled={!valid}
              onClick={() => onSubmit(serverFromForm(value))}
            >
              Save &amp; apply
            </SettingsButton>
          </div>
          <Footnote>
            Saving writes this server into your list, then applies it to the destinations above —
            each one reports what actually happened, above, once the daemon answers.
          </Footnote>
    </>
  )
}

export interface McpManagerProps {
  embedded?: boolean
  source: McpServer[]
  tools: McpToolState[]
  results: McpSyncResult[]
  checks: Array<[string, McpConnectionCheck]>
  loaded: boolean
  onRefresh: () => void
  onSync: (tool: AgentKind | null) => void
  onImport: (tool: AgentKind) => void
  onSetEnabled: (name: string, enabled: boolean) => void
  onUpsertServer: (previousName: string | null, server: McpServer) => void
  onRemoveServer: (name: string) => void
  onTest: (name: string) => void
  onOpenSource: () => void
  sourcePath?: string | null
  checkedAt?: number | null
  slackClient?: HoustonClient | null
}

export function McpManager(props: McpManagerProps): React.JSX.Element {
  const rows = buildRows(props.source, props.tools)
  return <McpConnectionsView props={props} rows={rows} />
}
