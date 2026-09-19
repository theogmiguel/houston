// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { McpManager } from './McpManager'
import type { McpServer } from '../houston/generated/McpServer'
import type { McpToolState } from '../houston/generated/McpToolState'
import type { AgentKind } from '../houston/generated/AgentKind'
import type { SkillToolState } from '../houston/generated/SkillToolState'
import { SkillMatrix } from './McpManager'

function typeInto(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function server(name: string, fingerprint: string, extra: Partial<McpServer> = {}): McpServer {
  return {
    name,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    env: [],
    url: null,
    headers: [],
    cwd: null,
    enabled: true,
    fingerprint,
    destinations: [],
    ...extra
  }
}

function column(tool: AgentKind, servers: McpServer[], detected = true): McpToolState {
  return { tool, path: `/home/dev/.${tool}/config`, detected, servers, error: null }
}

function noop(): void {}

function baseProps(): React.ComponentProps<typeof McpManager> {
  return {
    source: [server('context7', 'A')],
    tools: [
      column('claude', [server('context7', 'A')]),
      column('codex', [server('context7', 'B')]),
      column('opencode', [server('context7', 'A'), server('sentry', 'S')]),
      column('cursor', [], false)
    ],
    results: [],
    checks: [],
    loaded: true,
    onRefresh: noop,
    onSync: noop,
    onImport: noop,
    onSetEnabled: noop,
    onUpsertServer: noop,
    onRemoveServer: noop,
    onTest: noop,
    onOpenSource: noop
  }
}

describe('Settings › MCP servers — the matrix (row 36)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function render(props: Partial<React.ComponentProps<typeof McpManager>> = {}): void {
    act(() => {
      root.render(<McpManager {...baseProps()} {...props} />)
    })
  }

  function listItem(name: string): HTMLButtonElement {
    return Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="list-detail-item"]')).find(
      (b) => b.textContent?.includes(name)
    )!
  }

  function openRow(name: string): void {
    act(() => listItem(name).dispatchEvent(new MouseEvent('click', { bubbles: true })))
  }

  function settingsRows(): HTMLElement[] {
    return Array.from(container.querySelectorAll('[data-testid="settings-row"]'))
  }

  it('gives every server a row, its worst tool state as a StatusIcon, and lists a server no tool has in a Found in tools group', () => {
    render()
    const rows = Array.from(container.querySelectorAll('[data-testid="list-detail-row"]'))
    expect(rows).toHaveLength(1)
    const icon = rows[0].querySelector('[data-testid="status-icon"]')!
    expect(icon.getAttribute('data-state')).toBe('differs')
    expect(container.textContent).toContain('Found in tools')
    expect(container.textContent).toContain('sentry')
    expect(container.textContent).toContain('not in your list')
  })

  it('says a missing tool is not installed, rather than showing it as failed', () => {
    render()
    openRow('context7')
    expect(container.textContent).toContain('Not installed')
  })

  it('opens a row into its detail, with Command/Transport/Environment', () => {
    render()
    openRow('context7')
    const text = container.textContent ?? ''
    expect(text).toContain('Command')
    expect(text).toContain('npx -y @upstash/context7-mcp')
    expect(text).toContain('Transport')
    expect(text).toContain('stdio')
    expect(text).toContain('In each tool')
    expect(text).toContain('Codex')
  })

  it('Show diff reveals the fingerprinted raw config on both sides, for that one tool', () => {
    render()
    openRow('context7')
    expect(container.querySelectorAll('dl')).toHaveLength(0)
    const showDiff = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Show diff'
    )!
    act(() => showDiff.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const cards = Array.from(container.querySelectorAll('dl'))
    expect(cards).toHaveLength(2)
    expect(container.textContent).toContain('Codex')
  })

  it('masks a literal secret in the detail view but keeps the name of one', () => {
    render({
      source: [
        server('secretful', 'X', {
          env: [
            ['TOKEN', 'sk-live-abcdefgh'],
            ['REF', '${FROM_ENV}']
          ]
        })
      ],
      tools: [column('claude', [])]
    })
    openRow('secretful')
    const text = container.textContent ?? ''
    expect(text).toContain('TOKEN=sk-••••')
    expect(text).not.toContain('abcdefgh')
    expect(text).toContain('REF=${FROM_ENV}')
  })

  it('shows a refusal on the tool that refused, with its reason', () => {
    render({
      results: [
        {
          tool: 'codex',
          written: 0,
          removed: 0,
          skipped: ['context7: already declared in config.toml outside Houston’s block'],
          error: null
        }
      ]
    })
    openRow('context7')
    expect(container.textContent).toContain('already declared in config.toml')
  })

  it('says it is still asking rather than claiming an empty list', () => {
    render({ loaded: false })
    expect(container.textContent).toContain('Asking the daemon')
    expect(container.querySelector('[data-testid="list-detail-item"]')).toBeNull()
  })

  it('picking a server, then Back, returns to the list without losing it', () => {
    render()
    openRow('context7')
    expect(container.querySelector('[data-testid="nav-back"]')).not.toBeNull()
    expect(listItem('context7')).toBeDefined()
  })

  it('offers the enable switch only on servers Houston owns', () => {
    render()
    const rows = Array.from(container.querySelectorAll('[data-testid="list-detail-row"]'))
    expect(rows[0].querySelector('[data-testid="mcp-enabled-switch"]')).not.toBeNull()

    const flips: Array<[string, boolean]> = []
    render({ onSetEnabled: (n, e) => flips.push([n, e]) })
    const sw = container.querySelector<HTMLElement>('[data-testid="mcp-enabled-switch"]')!
    act(() => sw.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(flips).toEqual([['context7', false]])
  })

  it('sends the tool the user asked to sync, from the drifted tool\'s own row', () => {
    const synced: Array<AgentKind | null> = []
    render({ onSync: (tool) => synced.push(tool) })
    const syncAll = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Sync all'
    )!
    act(() => syncAll.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    openRow('context7')
    const perTool = Array.from(container.querySelectorAll('button')).filter(
      (b) => b.textContent === 'Sync'
    )
    act(() => perTool[0].dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(synced).toEqual([null, 'claude'])
  })

  it('flipping the switch applies it, not just changes the list', () => {
    const calls: string[] = []
    render({
      onSetEnabled: (n, e) => calls.push(`set ${n} ${e}`),
      onSync: (t) => calls.push(`sync ${t ?? 'all'}`)
    })
    const sw = container.querySelector<HTMLElement>('[data-testid="mcp-enabled-switch"]')!
    act(() => sw.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(calls).toEqual(['set context7 false', 'sync all'])
  })

  it('Add server opens a blank form in the detail pane; saving upserts then applies', () => {
    const upserted: Array<[string | null, string]> = []
    const synced: Array<AgentKind | null> = []
    render({
      onUpsertServer: (prev, s) => upserted.push([prev, s.name]),
      onSync: (t) => synced.push(t)
    })
    const add = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Add server'
    )!
    act(() => add.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(container.textContent).toContain('Add server')
    expect(listItem('context7')).toBeDefined()

    const name = container.querySelector<HTMLInputElement>('#mcp-form-name')!
    const command = container.querySelector<HTMLInputElement>('#mcp-form-command')!
    typeInto(name, 'docs')
    typeInto(command, 'npx')
    const save = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Save & apply'
    ) as HTMLButtonElement
    expect(save.disabled).toBe(false)
    act(() => save.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(upserted).toEqual([[null, 'docs']])
    expect(synced).toEqual([null])
  })

  it('Cancel from Add server closes the draft without a selection to fall back on', () => {
    render()
    const add = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Add server'
    )!
    act(() => add.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const cancel = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Cancel'
    )!
    act(() => cancel.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(container.textContent).toContain('Pick a server from the list')
  })

  it('refuses to save a name that collides with another server already in the list', () => {
    render()
    const add = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Add server'
    )!
    act(() => add.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const name = container.querySelector<HTMLInputElement>('#mcp-form-name')!
    const command = container.querySelector<HTMLInputElement>('#mcp-form-command')!
    typeInto(name, 'context7')
    typeInto(command, 'npx')
    const save = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Save & apply'
    ) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(container.textContent).toContain('already the name of another server')
  })

  it('Edit pre-fills the existing server and edits it in place', () => {
    const upserted: Array<[string | null, string]> = []
    render({ onUpsertServer: (prev, s) => upserted.push([prev, s.name]) })
    openRow('context7')
    const edit = container.querySelector<HTMLElement>('[aria-label="Edit context7"]')!
    act(() => edit.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(container.textContent).toContain('Edit context7')
    const name = container.querySelector<HTMLInputElement>('#mcp-form-name')!
    expect(name.value).toBe('context7')
    const command = container.querySelector<HTMLInputElement>('#mcp-form-command')!
    expect(command.value).toBe('npx')

    const save = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Save & apply'
    )!
    act(() => save.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(upserted).toEqual([['context7', 'context7']])
  })

  it('Remove asks for confirmation, then removes and applies', () => {
    const removed: string[] = []
    const synced: Array<AgentKind | null> = []
    render({ onRemoveServer: (n) => removed.push(n), onSync: (t) => synced.push(t) })
    openRow('context7')
    const remove = container.querySelector<HTMLElement>('[aria-label="remove context7"]')!
    act(() => remove.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(container.textContent).toContain('Remove context7')
    expect(removed).toEqual([])

    const confirm = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Remove'
    )!
    act(() => confirm.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(removed).toEqual(['context7'])
    expect(synced).toEqual([null])
  })

  it('shows Test connection for a not-checked server, then checking/verified/failed states', () => {
    const tested: string[] = []
    render({ onTest: (n) => tested.push(n) })
    openRow('context7')
    const test = container.querySelector<HTMLElement>('[data-check-state="not_checked"]')!
    act(() => test.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(tested).toEqual(['context7'])

    render({ checks: [['context7', { state: 'checking' }]] })
    openRow('context7')
    expect(container.querySelector('[data-check-state="checking"]')?.textContent).toContain(
      'Checking'
    )

    render({ checks: [['context7', { state: 'verified', tool_count: 4 }]] })
    openRow('context7')
    expect(container.querySelector('[data-check-state="verified"]')?.textContent).toContain(
      'Verified · 4 tools'
    )

    render({ checks: [['context7', { state: 'failed', message: 'connection refused' }]] })
    openRow('context7')
    const failed = container.querySelector<HTMLElement>('[data-check-state="failed"]')!
    expect(failed.textContent).toContain('Failed')
  })

  it('edits an existing argument containing a space without corrupting it', () => {
    const upserted: McpServer[] = []
    render({
      source: [server('context7', 'A', { args: ['--header', 'X-Key: has a space', '-y'] })],
      onUpsertServer: (_prev, s) => upserted.push(s)
    })
    openRow('context7')
    const edit = container.querySelector<HTMLElement>('[aria-label="Edit context7"]')!
    act(() => edit.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    const argInputs = Array.from(
      container.querySelectorAll<HTMLInputElement>('[aria-label^="argument "]')
    )
    expect(argInputs.map((i) => i.value)).toEqual(['--header', 'X-Key: has a space', '-y'])
    typeInto(argInputs[1], 'X-Key: still has a space, edited')

    const save = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Save & apply'
    ) as HTMLButtonElement
    act(() => save.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(upserted).toEqual([
      expect.objectContaining({
        args: ['--header', 'X-Key: still has a space, edited', '-y']
      })
    ])
  })

  it('adds a new argument via its own field, appended in order', () => {
    const upserted: McpServer[] = []
    render({
      source: [server('context7', 'A', { args: ['-y'] })],
      onUpsertServer: (_prev, s) => upserted.push(s)
    })
    openRow('context7')
    const edit = container.querySelector<HTMLElement>('[aria-label="Edit context7"]')!
    act(() => edit.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    const addArg = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Add argument'
    ) as HTMLButtonElement
    act(() => addArg.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const argInputs = Array.from(
      container.querySelectorAll<HTMLInputElement>('[aria-label^="argument "]')
    )
    expect(argInputs).toHaveLength(2)
    typeInto(argInputs[1], '@upstash/context7-mcp')

    const save = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Save & apply'
    ) as HTMLButtonElement
    act(() => save.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(upserted).toEqual([
      expect.objectContaining({ args: ['-y', '@upstash/context7-mcp'] })
    ])
  })

  it('removing an argument row drops only that one, in place', () => {
    const upserted: McpServer[] = []
    render({
      source: [server('context7', 'A', { args: ['-y', 'middle', '@upstash/context7-mcp'] })],
      onUpsertServer: (_prev, s) => upserted.push(s)
    })
    openRow('context7')
    const edit = container.querySelector<HTMLElement>('[aria-label="Edit context7"]')!
    act(() => edit.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    const removeMiddle = container.querySelector<HTMLElement>(
      '[aria-label="remove argument 2"]'
    )!
    act(() => removeMiddle.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    const save = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Save & apply'
    ) as HTMLButtonElement
    act(() => save.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(upserted).toEqual([
      expect.objectContaining({ args: ['-y', '@upstash/context7-mcp'] })
    ])
  })

  it('names each tool\'s state in words, not just a glyph, in the In each tool group', () => {
    render()
    openRow('context7')
    const rows = settingsRows()
    const words = rows.map((r) => r.querySelector('[data-testid="status-icon"]')?.textContent)
    expect(words).toContain('Differs')
  })

  it('always shows each tool\'s raw config path in the In each tool group', () => {
    render()
    openRow('context7')
    expect(container.textContent).toContain('/home/dev/.claude/config')
  })

  it('a discovered server not in the list offers Import, importing that tool\'s own servers', () => {
    const imported: AgentKind[] = []
    render({ onImport: (t) => imported.push(t) })
    const importBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Import'
    )!
    act(() => importBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(imported).toEqual(['opencode'])
  })

  it('does not claim secrets are never moved — syncing writes them into destination configs', () => {
    render()
    expect(container.textContent).not.toContain('never moved')
  })

  it('Open file opens the server list file', () => {
    const opened: number[] = []
    render({ onOpenSource: () => opened.push(1) })
    const open = container.querySelector<HTMLElement>('[aria-label="Open file"]')!
    act(() => open.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(opened).toEqual([1])
  })

  it('destinations default to "All tools" and narrow to the selection made', () => {
    const upserted: McpServer[] = []
    render({ onUpsertServer: (_prev, s) => upserted.push(s) })
    const add = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Add server'
    )!
    act(() => add.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(container.textContent).toContain('every tool')

    const name = container.querySelector<HTMLInputElement>('#mcp-form-name')!
    const command = container.querySelector<HTMLInputElement>('#mcp-form-command')!
    typeInto(name, 'docs')
    typeInto(command, 'npx')
    const codexChip = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Codex' && b.getAttribute('aria-pressed') !== null
    )!
    act(() => codexChip.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(container.textContent).toContain('Codex')

    const save = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Save & apply'
    )!
    act(() => save.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(upserted).toEqual([expect.objectContaining({ destinations: ['codex'] })])
  })
})

describe('Settings › Skills — the drift matrix (row 37)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function skillColumn(
    tool: AgentKind,
    names: Array<[string, string]>,
    inherits: boolean,
    detected = true
  ): SkillToolState {
    return {
      tool,
      path: `/home/dev/.${tool}/skills`,
      detected,
      inherits_claude: inherits,
      skills: names.map(([name, digest]) => ({
        name,
        path: `/home/dev/.${tool}/skills/${name}/SKILL.md`,
        digest
      })),
      error: null
    }
  }

  it('distinguishes "sees Claude’s copy" from "cannot see it"', () => {
    act(() => {
      root.render(
        <SkillMatrix
          loaded={true}
          pushes={[]}
          autoPushEnabled={false}
          onRefresh={noop}
          onPush={noop}
          onPushUndo={noop}
          onAutoPushSet={noop}
          tools={[
            skillColumn('claude', [['triage', 'A']], false),
            skillColumn('codex', [], false),
            skillColumn('cursor', [], true)
          ]}
        />
      )
    })
    const cells = Array.from(container.querySelectorAll<HTMLElement>('[data-skill-cell]'))
    expect(cells.map((c) => c.dataset.skillCell)).toEqual(['same', 'missing', 'inherited'])
    expect(cells[2].closest('[data-tooltip]')?.getAttribute('data-tooltip')).toContain(
      'reads Claude Code'
    )
    expect(cells[1].closest('[data-tooltip]')?.getAttribute('data-tooltip')).toContain(
      'cannot see'
    )
  })

  it('flags a native copy that drifted, on both sides', () => {
    act(() => {
      root.render(
        <SkillMatrix
          loaded={true}
          pushes={[]}
          autoPushEnabled={false}
          onRefresh={noop}
          onPush={noop}
          onPushUndo={noop}
          onAutoPushSet={noop}
          tools={[
            skillColumn('claude', [['triage', 'A']], false),
            skillColumn('cursor', [['triage', 'B']], true)
          ]}
        />
      )
    })
    const cells = Array.from(container.querySelectorAll<HTMLElement>('[data-skill-cell]'))
    expect(cells.map((c) => c.dataset.skillCell)).toEqual(['differs', 'differs'])
  })

  it('says what the glyphs mean, and that Houston does not write here', () => {
    act(() => {
      root.render(
        <SkillMatrix
            loaded={true}
            pushes={[]}
            autoPushEnabled={false}
            onRefresh={noop}
            onPush={noop}
            onPushUndo={noop}
            onAutoPushSet={noop}
            tools={[skillColumn('claude', [], false)]}
          />
      )
    })
    const text = container.textContent ?? ''
    expect(text).toContain('sees Claude')
    expect(text).toContain('clickable')
  })

  it('clicking a drifted cell pushes that (tool, skill), not the whole matrix', () => {
    const onPush = vi.fn()
    act(() => {
      root.render(
        <SkillMatrix
          loaded={true}
          pushes={[]}
          autoPushEnabled={false}
          onRefresh={noop}
          onPush={onPush}
          onPushUndo={noop}
          onAutoPushSet={noop}
          tools={[
            skillColumn('claude', [['triage', 'A']], false),
            skillColumn('cursor', [], true)
          ]}
        />
      )
    })
    const button = container.querySelector<HTMLButtonElement>(
      '[aria-label="Push triage into Cursor"]'
    )
    expect(button).not.toBeNull()
    act(() => {
      button!.click()
    })
    expect(onPush).toHaveBeenCalledWith('cursor', 'triage')
  })

  it('"Push all drifted" pushes with no args, and is disabled when nothing has drifted', () => {
    const onPush = vi.fn()
    act(() => {
      root.render(
        <SkillMatrix
          loaded={true}
          pushes={[]}
          autoPushEnabled={false}
          onRefresh={noop}
          onPush={onPush}
          onPushUndo={noop}
          onAutoPushSet={noop}
          tools={[skillColumn('claude', [['triage', 'A']], false), skillColumn('cursor', [], true)]}
        />
      )
    })
    const pushAll = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Push all drifted'
    ) as HTMLButtonElement
    expect(pushAll.disabled).toBe(false)
    act(() => {
      pushAll.click()
    })
    expect(onPush).toHaveBeenCalledWith()

    act(() => {
      root.render(
        <SkillMatrix
          loaded={true}
          pushes={[]}
          autoPushEnabled={false}
          onRefresh={noop}
          onPush={onPush}
          onPushUndo={noop}
          onAutoPushSet={noop}
          tools={[skillColumn('claude', [['triage', 'A']], false)]}
        />
      )
    })
    const pushAllNowNothingDrifted = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Push all drifted'
    ) as HTMLButtonElement
    expect(pushAllNowNothingDrifted.disabled).toBe(true)
  })

  it('lists a push in the undo ledger and fires onPushUndo for it', () => {
    const onPushUndo = vi.fn()
    act(() => {
      root.render(
        <SkillMatrix
          loaded={true}
          pushes={[
            {
              tool: 'cursor',
              skill: 'triage',
              path: '/home/dev/.cursor/skills/triage/SKILL.md',
              pushed_at: 1_755_000_000,
              had_existing: false
            }
          ]}
          autoPushEnabled={false}
          onRefresh={noop}
          onPush={noop}
          onPushUndo={onPushUndo}
          onAutoPushSet={noop}
          tools={[skillColumn('claude', [['triage', 'A']], false)]}
        />
      )
    })
    expect(container.textContent).toContain('Pushed by Houston')
    expect(container.textContent).toContain('created new')
    const undoButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Undo pushing triage into Cursor"]'
    )!
    act(() => {
      undoButton.click()
    })
    expect(onPushUndo).toHaveBeenCalledWith('cursor', 'triage')
  })

  it('the auto-push switch reflects and toggles the setting', () => {
    const onAutoPushSet = vi.fn()
    act(() => {
      root.render(
        <SkillMatrix
          loaded={true}
          pushes={[]}
          autoPushEnabled={false}
          onRefresh={noop}
          onPush={noop}
          onPushUndo={noop}
          onAutoPushSet={onAutoPushSet}
          tools={[skillColumn('claude', [], false)]}
        />
      )
    })
    const toggle = container.querySelector('[data-testid="skills-auto-push"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    act(() => {
      toggle.click()
    })
    expect(onAutoPushSet).toHaveBeenCalledWith(true)
  })
})
