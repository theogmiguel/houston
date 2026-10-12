// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const pwa = resolve(process.cwd(), '../core/houston-core/src/remote/pwa')
const html = readFileSync(resolve(pwa, 'index.html'), 'utf8')
const source = readFileSync(resolve(pwa, 'app.js'), 'utf8')
const project = { name: 'Houston', path: '/projects/houston' }
const worktree = { name: 'worker', path: '/projects/houston/.houston/worktrees/worker' }
const other = { name: 'Other', path: '/projects/other' }

function pane(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id, title: `Pane ${id}`, parent: null, role: null, workspace: project,
    kind: 'codex', state: 'running', status: 'working', status_since: 1000,
    pending: null, last_step: 'Bash cargo test', last_reply_excerpt: null, ...overrides
  }
}

type Pane = ReturnType<typeof pane>

async function open(sessions: Pane[], workspaceFilter?: string) {
  const document = new DOMParser().parseFromString(html, 'text/html')
  const storage = new Map([['houston.remote.token', 'fixture-token']])
  if (workspaceFilter) storage.set('houston.remote.workspace', workspaceFilter)
  const fetch = vi.fn(async (path: string) => {
    if (path === '/api/events') return new Promise<Response>(() => {})
    let data: unknown
    if (path === '/api/me') data = { host: { name: 'Fixture computer' }, dictation: false }
    else if (path === '/api/sessions') data = {
      sessions,
      grids: [{ id: 'main', name: 'Main', workspace: project.path, sessions: sessions.map(s => s.id) }]
    }
    else if (/\/feed\?/.test(path)) data = { epoch: '0123456789abcdef', last_seq: 0, entries: [], pending: null }
    else throw new Error(`Unexpected PWA request: ${path}`)
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
  })
  const context = createContext({
    document, fetch, AbortController, navigator: { userAgent: 'Fixture browser' },
    location: { hash: '', hostname: 'fixture', pathname: '/' },
    history: { replaceState: vi.fn() },
    window: { addEventListener: vi.fn(), scrollTo: vi.fn(), innerHeight: 844 },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key)
    },
    setTimeout: vi.fn(), clearTimeout: vi.fn(), requestAnimationFrame: vi.fn()
  })
  runInContext(source, context)
  await vi.waitFor(() => expect(document.querySelector('.all-clear, .inbox')).not.toBeNull())
  const click = (selector: string) => {
    const button = document.querySelector<HTMLButtonElement>(selector)
    expect(button, selector).not.toBeNull()
    button!.click()
  }
  return { document, click, fetch }
}

function titles(document: Document, selector: string) {
  return Array.from(document.querySelectorAll(selector), node => node.textContent)
}

describe('remote pane hierarchy', () => {
  it('lists root agents, handoffs and shells without promoting workers from published grids', async () => {
    const { document, click } = await open([
      pane(1, { title: 'Orchestrator', kind: 'claude' }),
      pane(2, { parent: 1, role: 'worker' }),
      pane(3, { parent: 2, role: 'nested-worker', workspace: worktree }),
      pane(4, { title: 'Shell', kind: 'custom', status: null }),
      pane(5, { title: 'Handoff', role: 'Independent task' })
    ])
    click('[data-tab="panes"]')
    expect(titles(document, '.tile > b')).toEqual(['Orchestrator', 'Handoff', 'Shell'])
    expect(document.querySelector('.summary')?.textContent).toBe('3 panes')
    expect(document.querySelector('.tile-child')).toBeNull()
  })

  it('counts root panes in workspace filters and drops child-only worktree filters', async () => {
    const { document, click } = await open([
      pane(1), pane(2, { parent: 1, workspace: worktree }), pane(3, { workspace: other })
    ], worktree.path)
    click('[data-tab="panes"]')
    expect(titles(document, '.chip')).toEqual(['All2', 'Houston1', 'Other1'])
    expect(document.querySelector('.summary')?.textContent).toBe('2 panes')
    click('.chip:last-child')
    expect(titles(document, '.tile > b')).toEqual(['Pane 3'])
    expect(document.querySelector('.summary')?.textContent).toBe('1 pane')
  })

  it('keeps working and last-finished home rows at the root level', async () => {
    const { document } = await open([
      pane(1, { title: 'Orchestrator' }), pane(2, { parent: 1, role: 'working-child' }),
      pane(3, { title: 'Finished root', status: 'idle', last_reply_excerpt: 'Done' }),
      pane(4, { parent: 1, role: 'finished-child', status: 'idle', last_reply_excerpt: 'Done' })
    ])
    expect(titles(document, '#list .row-title')).toEqual(['Orchestrator', 'Finished root'])
    expect(document.querySelector('.all-clear .empty-body')?.textContent).toContain('1 agent is working')
  })

  it('opens workers through their parent and shows status beside clean provider avatars', async () => {
    const { document, click } = await open([
      pane(1, { title: 'Orchestrator', kind: 'claude' }),
      pane(2, { parent: 1, role: 'worker' }), pane(3, { parent: 2, role: 'nested-worker' })
    ])
    expect(document.querySelector('.avatar .sdot')).toBeNull()
    expect(document.querySelector('#list .row-end .spinner')).not.toBeNull()
    click('#list .row')
    expect(titles(document, '#children .row-title')).toEqual(['worker'])
    expect(document.querySelector('#children .avatar .sdot')).toBeNull()
    expect(document.querySelector('#children .row-end .spinner')).not.toBeNull()
    click('#children .row')
    expect(document.querySelector('#heading')?.textContent).toBe('worker')
    expect(document.querySelector('#subheading')?.textContent).toBe('Orchestrator / Houston')
    expect(titles(document, '#children .row-title')).toEqual(['nested-worker'])
  })

  it('still surfaces a child that needs the operator in the inbox', async () => {
    const { document, click } = await open([
      pane(1), pane(2, { parent: 1, role: 'Waiting worker', status: 'needs-input' })
    ])
    expect(document.querySelector('.inbox-who')?.textContent).toContain('Waiting worker')
    expect(document.querySelector('[data-tab="inbox"] .badge')?.textContent).toBe('1')
    click('[data-tab="panes"]')
    expect(titles(document, '.tile > b')).toEqual(['Pane 1'])
    click('.tile')
    expect(document.querySelector('#child-band')?.textContent).toContain('Waiting worker needs you')
  })
})
