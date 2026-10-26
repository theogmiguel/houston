// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient } from './client'
import type { ServerMsg } from './generated/ServerMsg'
import type { SuspectedDefect } from './generated/SuspectedDefect'
import { useSuspectedDefects } from './useSuspectedDefects'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WS = '/home/dev/proj'

function defect(overrides: Partial<SuspectedDefect> = {}): SuspectedDefect {
  return {
    workspace: WS,
    key: 'repeated-refusal',
    title: 'A pane_reply was refused twice for one question',
    source: 'detector',
    detector: 'reply_refused',
    evidence: ['message 91'],
    destination: 'houston',
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

function Probe({ client, workspace }: { client: HoustonClient; workspace: string }): React.JSX.Element {
  const { defects, loaded } = useSuspectedDefects(client, workspace)
  return <div>{loaded ? defects.map((row) => row.title).join(',') : 'loading'}</div>
}

describe('useSuspectedDefects', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('asks for the workspace list and follows its broadcasts, ignoring another workspace', () => {
    const handlers = new Map<string, (msg: ServerMsg) => void>()
    const client = {
      subscribe: vi.fn((type: string, callback: (msg: ServerMsg) => void) => {
        handlers.set(type, callback)
        return () => handlers.delete(type)
      }),
      defectsGet: vi.fn()
    } as unknown as HoustonClient

    act(() => root.render(<Probe client={client} workspace={WS} />))
    expect(client.defectsGet).toHaveBeenCalledWith(WS)
    expect(container.textContent).toBe('loading')

    act(() => handlers.get('suspected_defects')?.({ type: 'suspected_defects', workspace: '/other', defects: [defect({ workspace: '/other', title: 'Elsewhere' })] }))
    expect(container.textContent).toBe('loading')

    act(() => handlers.get('suspected_defects')?.({ type: 'suspected_defects', workspace: WS, defects: [defect()] }))
    expect(container.textContent).toBe('A pane_reply was refused twice for one question')
  })
})
