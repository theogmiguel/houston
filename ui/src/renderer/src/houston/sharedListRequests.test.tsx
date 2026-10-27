// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { HoustonClient } from './client'
import { CONTROL_HANDLERS_PER_CONNECTION } from './boundedPoller'
import { SHARED_LIST_IN_FLIGHT_LIMIT } from './sharedListRequests'
import { usePrWatch } from '../components/git/usePrWatch'
import { useMergeQueue } from '../components/prs/useMergeQueue'
import { useMergeQueueParked } from '../components/prs/mergeQueueSignals'

type Handler = (message: never) => void

// One `/ws` connection that holds a control handler per request until its reply.
class FakeConnection {
  readonly handlers = new Map<string, Set<Handler>>()
  readonly sent: string[] = []
  readonly pending: { type: string; dir?: string }[] = []
  peak = 0

  subscribe(type: string, handler: Handler): () => void {
    const set = this.handlers.get(type) ?? new Set()
    set.add(handler)
    this.handlers.set(type, set)
    return () => set.delete(handler)
  }
  send(message: { type: string }): void { this.hold(message.type) }
  mergeQueueGet(dir: string): void { this.hold('merge_queue_get', dir) }
  mergeQueueSummaryGet(): void { this.hold('merge_queue_summary_get') }
  replyAll(): void {
    for (let replies = 0; this.pending.length > 0; replies += 1) {
      if (replies > 1000) throw new Error(`replies never settle: ${this.pending.length} still pending`)
      const { type, dir } = this.pending.shift()!
      act(() => {
        if (type === 'pr_watch_list') this.emit('pr_watch_list', { type: 'pr_watch_list', watches: [] })
        else if (type === 'merge_queue_summary_get') this.emit('merge_queue_summary', { type: 'merge_queue_summary', parked: [], global_paused: false })
        else this.emit('merge_queue', { type: 'merge_queue', dir, workspace: dir, entries: [], log: [] })
      })
    }
  }
  private hold(type: string, dir?: string): void {
    this.sent.push(dir === undefined ? type : `${type}:${dir}`)
    this.pending.push({ type, dir })
    this.peak = Math.max(this.peak, this.pending.length)
  }
  private emit(type: string, message: unknown): void {
    for (const handler of [...(this.handlers.get(type) ?? [])]) handler(message as never)
  }
}

const clientOf = (connection: FakeConnection): HoustonClient => connection as unknown as HoustonClient

function PrWatchPane({ client, session }: { client: HoustonClient; session: number }): null {
  usePrWatch(client, session)
  return null
}
function MergeQueueView({ client, dir }: { client: HoustonClient; dir: string }): null {
  useMergeQueue(client, dir, true)
  return null
}
function ParkedCount({ client }: { client: HoustonClient }): null {
  useMergeQueueParked(client)
  return null
}

describe('shared list requests', () => {
  afterEach(cleanup)

  test('75 mounted panes ask for the PR watch list once', () => {
    const connection = new FakeConnection()
    const client = clientOf(connection)
    render(<>{Array.from({ length: 75 }, (_, id) => <PrWatchPane key={id} client={client} session={id + 1} />)}</>)
    expect(connection.sent.filter((type) => type === 'pr_watch_list')).toHaveLength(1)
  })

  test('a burst over every key stays within the in-flight bound and sends each key once', () => {
    const connection = new FakeConnection()
    const client = clientOf(connection)
    const dirs = Array.from({ length: 30 }, (_, i) => `/ws-${i}`)
    render(<>
      {Array.from({ length: 75 }, (_, id) => <PrWatchPane key={id} client={client} session={id + 1} />)}
      {dirs.flatMap((dir) => [<MergeQueueView key={`a${dir}`} client={client} dir={dir} />, <MergeQueueView key={`b${dir}`} client={client} dir={dir} />])}
      <ParkedCount client={client} />
      <ParkedCount client={client} />
    </>)
    connection.replyAll()
    expect(SHARED_LIST_IN_FLIGHT_LIMIT).toBeLessThan(CONTROL_HANDLERS_PER_CONNECTION)
    expect(connection.peak, 'requests in flight').toBeLessThanOrEqual(SHARED_LIST_IN_FLIGHT_LIMIT)
    expect([...connection.sent].sort()).toEqual([
      'merge_queue_summary_get',
      'pr_watch_list',
      ...dirs.map((dir) => `merge_queue_get:${dir}`),
    ].sort())
  })

  test('a key asked again after its reply is sent again', () => {
    const connection = new FakeConnection()
    const client = clientOf(connection)
    const first = render(<PrWatchPane client={client} session={1} />)
    connection.replyAll()
    first.unmount()
    vi.useFakeTimers()
    render(<PrWatchPane client={client} session={2} />)
    vi.useRealTimers()
    expect(connection.sent).toEqual(['pr_watch_list', 'pr_watch_list'])
  })
})
