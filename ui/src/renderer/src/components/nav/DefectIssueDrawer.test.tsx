// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient } from '../../houston/client'
import type { ServerMsg } from '../../houston/generated/ServerMsg'
import type { SuspectedDefect } from '../../houston/generated/SuspectedDefect'
import { DefectIssueDrawer } from './DefectIssueDrawer'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WS = '/home/dev/proj'
const KEY = 'repeated-refusal'

function defect(overrides: Partial<SuspectedDefect> = {}): SuspectedDefect {
  return {
    workspace: WS,
    key: KEY,
    title: 'A pane_reply was refused twice for one question',
    source: 'agent',
    detector: null,
    evidence: ['message 91'],
    destination: 'workspace',
    count: 2,
    first_seen_ms: 1,
    last_seen_ms: 2,
    state: 'open',
    recurred: false,
    issue_url: null,
    decided_at_ms: null,
    ...overrides
  }
}

function fakeClient() {
  const handlers = new Map<string, Set<(msg: ServerMsg) => void>>()
  const client = {
    subscribe: (kind: string, handler: (msg: ServerMsg) => void) => {
      const set = handlers.get(kind) ?? new Set()
      set.add(handler)
      handlers.set(kind, set)
      return () => set.delete(handler)
    },
    defectIssueDraft: vi.fn(),
    defectIssueFile: vi.fn()
  }
  const emit = (msg: ServerMsg): void => {
    act(() => handlers.get(msg.type)?.forEach((handler) => handler(msg)))
  }
  return { client, emit, asClient: client as unknown as HoustonClient }
}

function draft(request: number, overrides: Record<string, unknown> = {}): ServerMsg {
  return {
    type: 'defect_issue_draft',
    workspace: WS,
    key: KEY,
    request,
    destination: 'workspace',
    destination_repo: 'acme/houston',
    account: 'octocat',
    title: 'Pane reply refusal',
    body: 'A pane_reply was refused twice for one question.',
    transmits: 'Creates an issue in acme/houston with this title and body as octocat.',
    duplicates: [],
    note: null,
    ...overrides
  }
}

function filed(request: number): ServerMsg {
  return {
    type: 'defect_issue_filed',
    workspace: WS,
    key: KEY,
    request,
    number: 43,
    issue_url: 'https://github.com/acme/houston/issues/43',
    note: null
  }
}

describe('DefectIssueDrawer', () => {
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
    document.body.innerHTML = ''
  })

  function render(client: HoustonClient, row: SuspectedDefect | null = defect()): void {
    act(() => root.render(<DefectIssueDrawer client={client} defect={row} onClose={vi.fn()} />))
  }

  function byTestId(id: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  }

  function button(label: string): HTMLButtonElement {
    const found = Array.from(document.querySelectorAll('button')).find((node) => node.textContent?.trim() === label)
    if (!found) throw new Error(`no button "${label}"`)
    return found
  }

  it('asks for the draft on open, shows the destination and sends nothing until the button', () => {
    const { client, emit, asClient } = fakeClient()
    render(asClient)
    expect(client.defectIssueDraft).toHaveBeenCalledTimes(1)
    const request = client.defectIssueDraft.mock.calls[0]![2]
    expect(client.defectIssueDraft).toHaveBeenCalledWith(WS, KEY, request)
    expect(document.body.textContent).toContain('Preparing the draft…')

    emit(draft(request))
    expect(document.body.textContent).toContain('acme/houston')
    expect(document.body.textContent).toContain('Creates an issue in acme/houston with this title and body as octocat.')
    expect(document.body.textContent).toContain('octocat')
    expect(client.defectIssueFile).not.toHaveBeenCalled()
  })

  it('sends the edited title and body to the drafted repository on Create issue', () => {
    const { client, emit, asClient } = fakeClient()
    render(asClient)
    const request = client.defectIssueDraft.mock.calls[0]![2]
    emit(draft(request))

    fireEvent.change(document.querySelector<HTMLInputElement>('input')!, { target: { value: 'Edited title' } })
    fireEvent.change(document.querySelector<HTMLTextAreaElement>('textarea')!, { target: { value: 'Edited body' } })
    act(() => button('Create issue').click())

    expect(client.defectIssueFile).toHaveBeenCalledWith(WS, KEY, expect.any(Number), 'Edited title', 'Edited body', 'acme/houston', null)
    expect(button('Sending…').disabled).toBe(true)

    emit(filed(client.defectIssueFile.mock.calls[0]![2]))
    expect(document.body.textContent).toContain('Issue #43 created')
    expect(document.body.textContent).toContain('https://github.com/acme/houston/issues/43')
  })

  it('switches the confirm action to a comment on a matching issue', () => {
    const { client, emit, asClient } = fakeClient()
    render(asClient)
    const request = client.defectIssueDraft.mock.calls[0]![2]
    emit(draft(request, {
      duplicates: [{ number: 42, title: 'Pane replies lose their body', url: 'https://github.com/acme/houston/issues/42' }]
    }))

    act(() => button('Comment on #42 instead').click())
    expect(button('Add comment to #42')).toBeTruthy()
    expect(client.defectIssueFile).not.toHaveBeenCalled()

    act(() => button('Add comment to #42').click())
    expect(client.defectIssueFile).toHaveBeenCalledWith(WS, KEY, expect.any(Number), 'Pane reply refusal', 'A pane_reply was refused twice for one question.', 'acme/houston', 42)
  })

  it('can go back from commenting to creating a new issue', () => {
    const { client, emit, asClient } = fakeClient()
    render(asClient)
    const request = client.defectIssueDraft.mock.calls[0]![2]
    emit(draft(request, {
      duplicates: [{ number: 42, title: 'Pane replies lose their body', url: 'https://github.com/acme/houston/issues/42' }]
    }))

    act(() => button('Comment on #42 instead').click())
    act(() => button('Create a new issue instead').click())
    expect(button('Create issue')).toBeTruthy()
  })

  it('shows the daemon refusal instead of a draft, and closing sends nothing', () => {
    const { client, emit, asClient } = fakeClient()
    const onClose = vi.fn()
    act(() => root.render(<DefectIssueDrawer client={asClient} defect={defect()} onClose={onClose} />))
    const request = client.defectIssueDraft.mock.calls[0]![2]
    emit({ type: 'error', context: `defect_issue:${request}`, message: 'The workspace remote is on Bitbucket, not GitHub.' })

    expect(byTestId('defect-draft-refusal')?.textContent).toContain('The workspace remote is on Bitbucket, not GitHub.')
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Close drawer"]')!.click())
    expect(onClose).toHaveBeenCalledOnce()
    expect(client.defectIssueFile).not.toHaveBeenCalled()
    expect(client.defectIssueDraft).toHaveBeenCalledTimes(1)
  })
})
