import { useState } from 'react'
import { Tooltip } from './Tooltip'
import {
  IconAlertTriangle,
  IconCheck,
  IconFile,
  IconLoaderCircle,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconServer,
  IconTrash
} from './icons'
import {
  BLOCK,
  CHROME_BUTTON,
  CHROME_BUTTON_DANGER,
  FIELD_INPUT,
  FIELD_LABEL,
  NavDetailState,
  NavEmpty,
  NavFootnote,
  NavSwitch,
  PRIMARY_BUTTON,
  ROW_TOP,
  ROW_TITLE,
  SECONDARY_BUTTON,
  chipClass
} from './nav/navChrome'
import { ConfirmModal } from './ConfirmModal'
import { Segmented } from './Segmented'
import { SectionHead, SettingsList, SettingsRow as Row, SubHead } from './settingsPrimitives'
import { StatusIcon, STATUS_ICON_WORD, type StatusIconState } from './StatusIcon'
import { CheckedStamp } from './CheckedStamp'
import { ListDetail, type ListDetailItem } from './nav/ListDetail'
import type { AgentKind } from '../houston/generated/AgentKind'
import type { McpConnectionCheck } from '../houston/generated/McpConnectionCheck'
import type { McpServer } from '../houston/generated/McpServer'
import type { McpSyncResult } from '../houston/generated/McpSyncResult'
import type { McpToolState } from '../houston/generated/McpToolState'
import type { McpTransport } from '../houston/generated/McpTransport'
import { buildRows, cellFor, maskSecret, type MatrixRow } from '../houston/mcpRows'
import { Icon } from './Icon'

const TOOL_LABEL: Partial<Record<AgentKind, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor'
}

function label(tool: AgentKind): string {
  return TOOL_LABEL[tool] ?? tool
}

const DESTINATIONS: AgentKind[] = ['claude', 'codex', 'opencode', 'cursor']

const SPIN_CLASS = 'inline-flex animate-spin'

const CELL_STATE: Record<ReturnType<typeof cellFor>['kind'], StatusIconState> = {
  'in-sync': 'ok',
  drifted: 'differs',
  disabled: 'off',
  absent: 'absent'
}

function worstMcpState(row: MatrixRow, tools: McpToolState[]): StatusIconState {
  const kinds = tools.map((t) => cellFor(row, t.tool).kind)
  if (kinds.includes('drifted')) return 'differs'
  if (kinds.includes('disabled')) return 'off'
  if (kinds.includes('in-sync')) return 'ok'
  return 'absent'
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
  return (
    <div className="rounded-[10px] border border-[var(--border)] bg-[var(--content-bg)] p-[14px]">
      <div className="mb-[8px] flex items-center justify-between gap-[8px]">
        <span className="[font-size:var(--tr-text-small-size)] font-semibold text-[var(--text-primary)]">{title}</span>
        <span className="truncate font-mono [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-faint)]">
          {server.fingerprint}
        </span>
      </div>
      <dl className="flex flex-col gap-[4px] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)]">
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-[8px]">
            <dt className="w-[76px] shrink-0 text-[var(--text-faint)]">{k}</dt>
            <dd className="min-w-0 break-all font-mono [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-primary)]">
              {v}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function CheckBadge({
  name,
  check,
  onTest
}: {
  name: string
  check: McpConnectionCheck
  onTest: (name: string) => void
}): React.JSX.Element {
  switch (check.state) {
    case 'checking':
      return (
        <span
          data-testid="mcp-check"
          data-check-state="checking"
          className="inline-flex items-center gap-[4px] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-secondary)]"
        >
          <span className={SPIN_CLASS}>
            <Icon glyph={IconLoaderCircle} role="small" />
          </span>
          Checking…
        </span>
      )
    case 'verified':
      return (
        <Tooltip label="Test again">
          <button
            type="button"
            data-testid="mcp-check"
            data-check-state="verified"
            className="inline-flex items-center gap-[4px] border-0 bg-transparent p-0 cursor-pointer [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--ok)]"
            onClick={() => onTest(name)}
          >
            <Icon glyph={IconCheck} role="small" />
            Verified · {check.tool_count} tool{check.tool_count === 1 ? '' : 's'}
          </button>
        </Tooltip>
      )
    case 'failed':
      return (
        <Tooltip label={check.message}>
          <button
            type="button"
            data-testid="mcp-check"
            data-check-state="failed"
            className="inline-flex items-center gap-[4px] border-0 bg-transparent p-0 cursor-pointer [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--danger)]"
            onClick={() => onTest(name)}
          >
            <Icon glyph={IconAlertTriangle} role="small" />
            Failed — retry
          </button>
        </Tooltip>
      )
    case 'not_checked':
      return (
        <button
          type="button"
          data-testid="mcp-check"
          data-check-state="not_checked"
          className={SECONDARY_BUTTON}
          onClick={() => onTest(name)}
        >
          Test connection
        </button>
      )
  }
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
    <div>
      <span className={FIELD_LABEL}>{legend}</span>
      <div className="flex flex-col gap-[6px]">
        {pairs.map(([k, v], i) => (
          <div key={i} className="flex items-center gap-[6px]">
            <input
              className={`${FIELD_INPUT} min-h-[var(--h-ctl)]`}
              placeholder={keyPlaceholder}
              value={k}
              onChange={(e) => {
                const next = [...pairs]
                next[i] = [e.target.value, v]
                onChange(next)
              }}
            />
            <input
              className={`${FIELD_INPUT} min-h-[var(--h-ctl)]`}
              placeholder="value"
              value={v}
              onChange={(e) => {
                const next = [...pairs]
                next[i] = [k, e.target.value]
                onChange(next)
              }}
            />
            <button
              type="button"
              aria-label={`remove ${legend.toLowerCase()} row ${i + 1}`}
              className={CHROME_BUTTON_DANGER}
              onClick={() => onChange(pairs.filter((_, j) => j !== i))}
            >
              <Icon glyph={IconTrash} role="small" />
            </button>
          </div>
        ))}
        <button
          type="button"
          className={`${SECONDARY_BUTTON} self-start`}
          onClick={() => onChange([...pairs, ['', '']])}
        >
          <Icon glyph={IconPlus} role="small" />
          Add
        </button>
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
    <div className="flex flex-col gap-[4px]">
      <span className={FIELD_LABEL}>Arguments</span>
      <div className="flex flex-col gap-[6px]">
        {args.map((a, i) => (
          <div key={i} className="flex items-center gap-[6px]">
            <input
              className={`${FIELD_INPUT} min-h-[var(--h-ctl)]`}
              aria-label={`argument ${i + 1}`}
              placeholder="-y"
              value={a}
              onChange={(e) => {
                const next = [...args]
                next[i] = e.target.value
                onChange(next)
              }}
            />
            <button
              type="button"
              aria-label={`remove argument ${i + 1}`}
              className={CHROME_BUTTON_DANGER}
              onClick={() => onChange(args.filter((_, j) => j !== i))}
            >
              <Icon glyph={IconTrash} role="small" />
            </button>
          </div>
        ))}
        <button
          type="button"
          className={`${SECONDARY_BUTTON} self-start`}
          onClick={() => onChange([...args, ''])}
        >
          <Icon glyph={IconPlus} role="small" />
          Add argument
        </button>
      </div>
      <p className="[font-size:var(--tr-text-small-size)] text-[var(--text-faint)]">
        One field per argument, in order — an embedded space is kept exactly as typed.
      </p>
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
          <h2 className="m-0 [font-size:17px] font-semibold text-[var(--text-primary)]">
            {previousName ? `Edit ${previousName}` : 'Add server'}
          </h2>
          <div className="flex flex-col gap-[4px]">
            <label className={FIELD_LABEL} htmlFor="mcp-form-name">
              Name
            </label>
            <input
              id="mcp-form-name"
              className={FIELD_INPUT}
              value={value.name}
              onChange={(e) => setValue({ ...value, name: e.target.value })}
              placeholder="context7"
              aria-invalid={nameTaken || undefined}
            />
            {nameTaken && (
              <p className="[font-size:var(--tr-text-small-size)] text-[var(--danger)]">
                {value.name.trim()} is already the name of another server in your list.
              </p>
            )}
          </div>

          <div>
            <span className={FIELD_LABEL}>Reached by</span>
            <Segmented
              aria-label="Transport"
              options={TRANSPORT_OPTIONS}
              value={value.transport}
              onChange={(transport) => setValue({ ...value, transport })}
            />
          </div>

          {value.transport === 'stdio' ? (
            <>
              <div>
                <label className={FIELD_LABEL} htmlFor="mcp-form-command">
                  Command
                </label>
                <input
                  id="mcp-form-command"
                  className={FIELD_INPUT}
                  value={value.command}
                  onChange={(e) => setValue({ ...value, command: e.target.value })}
                  placeholder="npx"
                />
              </div>
              <ArgListEditor
                args={value.args}
                onChange={(args) => setValue({ ...value, args })}
              />
              <div>
                <label className={FIELD_LABEL} htmlFor="mcp-form-cwd">
                  Working directory <span className="text-[var(--text-faint)]">(optional)</span>
                </label>
                <input
                  id="mcp-form-cwd"
                  className={FIELD_INPUT}
                  value={value.cwd}
                  onChange={(e) => setValue({ ...value, cwd: e.target.value })}
                  placeholder="/home/you/project"
                />
              </div>
            </>
          ) : (
            <div>
              <label className={FIELD_LABEL} htmlFor="mcp-form-url">
                URL
              </label>
              <input
                id="mcp-form-url"
                className={FIELD_INPUT}
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
          <p className="[font-size:var(--tr-text-small-size)] text-[var(--text-faint)]">
            A value starting with <code>$</code> or <code>${'{'}NAME{'}'}</code> is kept as a
            reference to an environment variable, never stored as the secret itself; the detail
            view masks anything else.
          </p>

          <div className="flex flex-col gap-[6px]">
            <span className={FIELD_LABEL}>Destinations</span>
            <div className="flex flex-wrap gap-[8px]">
              {DESTINATIONS.map((tool) => {
                const on = value.destinations.includes(tool)
                return (
                  <button
                    key={tool}
                    type="button"
                    aria-pressed={on}
                    className={chipClass(on)}
                    onClick={() =>
                      setValue({
                        ...value,
                        destinations: on
                          ? value.destinations.filter((t) => t !== tool)
                          : [...value.destinations, tool]
                      })
                    }
                  >
                    {label(tool)}
                  </button>
                )
              })}
            </div>
            <p className="[font-size:var(--tr-text-small-size)] text-[var(--text-faint)]">
              {value.destinations.length === 0
                ? 'Nothing selected — this server goes to every tool.'
                : `Saving applies it to exactly these: ${destinationsLabel(value.destinations)}.`}
            </p>
          </div>

          <label className="flex items-center gap-[8px] [font-size:var(--tr-text-ui-size)] text-[var(--text-primary)]">
            <NavSwitch
              on={value.enabled}
              label={value.enabled ? 'Turn this server off' : 'Turn this server on'}
              onChange={(enabled) => setValue({ ...value, enabled })}
            />
            Enabled
          </label>

          {results.length > 0 && (
            <div>
              <span className={FIELD_LABEL}>Applied to</span>
              <div className={BLOCK}>
                {results.map((r) => (
                  <div key={r.tool} className={ROW_TOP}>
                    <div className="min-w-0 flex-1 flex flex-col gap-[3px]">
                      <strong className={ROW_TITLE}>{label(r.tool)}</strong>
                      {r.error ? (
                        <div className="[font-size:var(--tr-text-small-size)] text-[var(--danger)]">
                          {r.error}
                        </div>
                      ) : r.skipped.length > 0 ? (
                        r.skipped.map((s) => (
                          <div key={s} className="[font-size:var(--tr-text-small-size)] text-[var(--warn)]">
                            {s}
                          </div>
                        ))
                      ) : (
                        <div className="[font-size:var(--tr-text-small-size)] text-[var(--text-secondary)]">
                          Wrote {r.written}, removed {r.removed}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center gap-[8px]">
            <button type="button" className={SECONDARY_BUTTON} onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className={PRIMARY_BUTTON}
              disabled={!valid}
              onClick={() => onSubmit(serverFromForm(value))}
            >
              Save &amp; apply
            </button>
          </div>
          <NavFootnote>
            Saving writes this server into your list, then applies it to the destinations above —
            each one reports what actually happened, above, once the daemon answers.
          </NavFootnote>
    </>
  )
}

export interface McpManagerProps {
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
}

export function McpManager(props: McpManagerProps): React.JSX.Element {
  const { source, tools, results, checks, loaded } = props
  const [form, setForm] = useState<{ previousName: string | null } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [diffState, setDiffState] = useState<{ row: string; tool: AgentKind } | null>(null)
  const rows: MatrixRow[] = buildRows(source, tools)

  if (!loaded) {
    return (
      <NavDetailState
        testId="mcp-loading"
        title="Opening servers…"
        detail="Asking the daemon what each tool has."
      />
    )
  }

  const setEnabledAndApply = (name: string, enabled: boolean): void => {
    props.onSetEnabled(name, enabled)
    props.onSync(null)
  }

  const inList = rows.filter((r) => r.source !== null)
  const foundOnly = rows.filter((r) => r.source === null)

  const listItems: ListDetailItem[] = inList.map((row) => {
    const server = row.source!
    return {
      id: row.name,
      title: row.name,
      sub: `${server.transport} · ${destinationsLabel(server.destinations)}`,
      right: (
        <div className="flex items-center gap-[8px]">
          <StatusIcon state={worstMcpState(row, tools)} />
          <NavSwitch
            on={server.enabled}
            label={server.enabled ? `Turn off ${row.name} and apply` : `Turn on ${row.name} and apply`}
            onChange={(on) => setEnabledAndApply(row.name, on)}
            testId="mcp-enabled-switch"
          />
        </div>
      )
    }
  })

  const emptyListRow = (
    <div data-testid="mcp-list-empty" className="flex flex-col gap-[4px] px-[10px] py-[12px]">
      <strong className="[font-size:var(--tr-text-ui-size)] font-semibold text-[var(--text-primary)]">
        No servers yet
      </strong>
      <p className="m-0 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.5] text-[var(--text-secondary)] text-pretty">
        Add one, or import a server one of your tools already has from the list below.
      </p>
    </div>
  )

  const actions = (
    <>
      <CheckedStamp at={props.checkedAt ?? null} />
      <Tooltip label={props.sourcePath ?? 'Open the server list file'}>
        <button
          type="button"
          aria-label="Open file"
          className={CHROME_BUTTON}
          onClick={props.onOpenSource}
        >
          <Icon glyph={IconFile} role="small" />
        </button>
      </Tooltip>
      <Tooltip label="Re-read every tool's own config">
        <button type="button" aria-label="Refresh" className={CHROME_BUTTON} onClick={props.onRefresh}>
          <Icon glyph={IconRefresh} role="small" />
        </button>
      </Tooltip>
      <button type="button" className={SECONDARY_BUTTON} onClick={() => props.onSync(null)}>
        Sync all
      </button>
      <button
        type="button"
        className={PRIMARY_BUTTON}
        onClick={() => setForm({ previousName: null })}
      >
        <Icon glyph={IconPlus} role="small" />
        Add server
      </button>
    </>
  )

  return (
    <div data-testid="mcp-manager" className="flex flex-col gap-[var(--space-5)]">
      <SectionHead
        title="Connections"
        lede="One MCP server list, written into every CLI's own config."
        actions={actions}
      />
      {rows.length === 0 ? (
        <NavEmpty
          testId="mcp-empty"
          title="No MCP servers anywhere yet"
          icon={<Icon glyph={IconServer} role="display" />}
          action={
            <button
              type="button"
              className={`${PRIMARY_BUTTON} w-[160px]`}
              onClick={() => setForm({ previousName: null })}
            >
              Add server
            </button>
          }
        >
          Nothing in your list, and nothing in any tool&apos;s own config. Add one, or import what
          a tool already has, from the list below.
        </NavEmpty>
      ) : (
        <ListDetail
          items={listItems}
          backLabel="Connections"
          forceDetailOpen={form !== null}
          onCloseForced={() => setForm(null)}
          listHead={
            <span className="px-[2px] py-[4px] block [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] [text-transform:var(--tr-text-label-transform)] text-[var(--text-faint)]">
              Your list · <span className="tabular-nums">{inList.length}</span>
            </span>
          }
          listEmpty={emptyListRow}
          renderDetail={(item) => {
            if (form) {
              const editingSource = form.previousName
                ? (rows.find((r) => r.name === form.previousName)?.source ?? null)
                : null
              return (
                <McpServerForm
                  previousName={form.previousName}
                  initial={editingSource ? formFromServer(editingSource) : emptyForm()}
                  existingNames={source.map((s) => s.name)}
                  results={results}
                  onCancel={() => setForm(null)}
                  onSubmit={(server) => {
                    props.onUpsertServer(form.previousName, server)
                    props.onSync(null)
                    setForm(null)
                  }}
                />
              )
            }
            if (!item) {
              return (
                <div className="flex-1 flex items-center justify-center text-center [font-size:var(--tr-text-small-size)] text-[var(--text-faint)]">
                  Pick a server from the list to see its details.
                </div>
              )
            }
            const row = rows.find((r) => r.name === item.id)
            if (!row || !row.source) return null
            const server = row.source
            const diffTool = diffState?.row === row.name ? diffState.tool : null
            return (
              <>
                <div className="flex items-center justify-between gap-[10px]">
                  <h2 className="m-0 min-w-0 truncate [font-size:17px] font-semibold text-[var(--text-primary)]">
                    {row.name}
                  </h2>
                  <div className="flex-none flex items-center gap-[6px]">
                    <CheckBadge name={row.name} check={checkFor(row.name, checks)} onTest={props.onTest} />
                    <Tooltip label="Edit server">
                      <button
                        type="button"
                        aria-label={`Edit ${row.name}`}
                        className={CHROME_BUTTON}
                        onClick={() => setForm({ previousName: row.name })}
                      >
                        <Icon glyph={IconPencil} role="small" />
                      </button>
                    </Tooltip>
                    <Tooltip label="Remove server">
                      <button
                        type="button"
                        aria-label={`remove ${row.name}`}
                        className={CHROME_BUTTON_DANGER}
                        onClick={() => setConfirmRemove(row.name)}
                      >
                        <Icon glyph={IconTrash} role="small" />
                      </button>
                    </Tooltip>
                  </div>
                </div>
                <SettingsList>
                  <Row title="Command">
                    <span className="font-mono [font-size:var(--tr-text-small-size)] text-[var(--text-primary)] break-all">
                      {server.command ? [server.command, ...server.args].join(' ') : (server.url ?? '—')}
                    </span>
                  </Row>
                  <Row title="Transport">
                    <span className="[font-size:var(--tr-text-small-size)] text-[var(--text-primary)]">
                      {server.transport}
                    </span>
                  </Row>
                  <Row title="Environment">
                    <span className="font-mono [font-size:var(--tr-text-small-size)] text-[var(--text-primary)] break-all">
                      {server.env.length > 0
                        ? server.env.map(([k, v]) => `${k}=${maskSecret(v)}`).join(' ')
                        : '—'}
                    </span>
                  </Row>
                </SettingsList>
                <div className="flex flex-col gap-[6px]">
                  <span className="[font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] [text-transform:var(--tr-text-label-transform)] text-[var(--text-faint)]">
                    In each tool
                  </span>
                  <SettingsList>
                    {tools.map((t) => {
                      const cell = cellFor(row, t.tool)
                      const state = CELL_STATE[cell.kind]
                      const toolServer = row.byTool[t.tool]
                      const commandDiffers =
                        cell.kind === 'drifted' &&
                        toolServer !== undefined &&
                        server.command !== null &&
                        toolServer.command !== server.command
                      const result = results.find((r) => r.tool === t.tool)
                      return (
                        <Row
                          key={t.tool}
                          title={
                            <span className={t.detected ? '' : 'text-[var(--text-secondary)]'}>
                              {label(t.tool)}
                            </span>
                          }
                          desc={
                            <>
                              <span className="font-mono">
                                {t.path}
                                {commandDiffers ? ' · its copy has a different command' : ''}
                              </span>
                              {t.error && <span className="block text-[var(--danger)]">{t.error}</span>}
                              {result?.error && (
                                <span className="block text-[var(--danger)]">{result.error}</span>
                              )}
                              {result?.skipped.map((s) => (
                                <span key={s} className="block text-[var(--warn)]">
                                  {s}
                                </span>
                              ))}
                            </>
                          }
                        >
                          <div className="flex items-center gap-[8px]">
                            <StatusIcon
                              state={state}
                              label={t.detected ? STATUS_ICON_WORD[state] : 'Not installed'}
                            />
                            {cell.kind === 'drifted' && (
                              <>
                                <button
                                  type="button"
                                  className={SECONDARY_BUTTON}
                                  aria-pressed={diffTool === t.tool}
                                  onClick={() =>
                                    setDiffState(
                                      diffTool === t.tool ? null : { row: row.name, tool: t.tool }
                                    )
                                  }
                                >
                                  {diffTool === t.tool ? 'Hide diff' : 'Show diff'}
                                </button>
                                <button
                                  type="button"
                                  className={SECONDARY_BUTTON}
                                  onClick={() => props.onSync(t.tool)}
                                >
                                  Sync
                                </button>
                              </>
                            )}
                          </div>
                        </Row>
                      )
                    })}
                  </SettingsList>
                  {diffTool && row.byTool[diffTool] && (
                    <div className="grid grid-cols-1 gap-[8px] @[520px]:grid-cols-2">
                      <DetailCard title="Your list" server={server} />
                      <DetailCard title={label(diffTool)} server={row.byTool[diffTool]!} />
                    </div>
                  )}
                </div>
              </>
            )
          }}
        />
      )}
      {foundOnly.length > 0 && (
        <div className="flex flex-col gap-[6px]">
          <SubHead>Found in tools</SubHead>
          <SettingsList>
            {foundOnly.map((row) => {
              const foundIn = tools.filter((t) => row.byTool[t.tool]).map((t) => label(t.tool))
              const importTool = tools.find((t) => row.byTool[t.tool])?.tool
              return (
                <Row key={row.name} title={row.name} desc={`${foundIn.join(', ')} · not in your list`}>
                  <Tooltip label={`Adopts every one of ${foundIn[0]}'s own servers, not only this one.`}>
                    <button
                      type="button"
                      className={SECONDARY_BUTTON}
                      onClick={() => importTool && props.onImport(importTool)}
                    >
                      Import
                    </button>
                  </Tooltip>
                </Row>
              )
            })}
          </SettingsList>
        </div>
      )}
      {confirmRemove && (
        <ConfirmModal
          title="REMOVE SERVER"
          message={`Remove ${confirmRemove} from your list and every tool it was applied to?`}
          confirmLabel="Remove"
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => {
            props.onRemoveServer(confirmRemove)
            props.onSync(null)
            setConfirmRemove(null)
          }}
        />
      )}
    </div>
  )
}

export { SkillMatrix } from './SkillDistribution'
