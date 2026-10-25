import { describe, expect, it } from 'vitest'
import type { HoustonClient } from './client'
import type { ClientMsg } from './generated/ClientMsg'
import type { ServerMsg } from './generated/ServerMsg'
import { exportTransfer } from './transfer'

function fakeClient() {
  const handlers = new Set<(msg: ServerMsg) => void>()
  const closeHandlers = new Set<() => void>()
  const sent: ClientMsg[] = []
  const client = {
    onClose: () => {},
    subscribeAll: (handler: (msg: ServerMsg) => void) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    subscribeClose: (handler: () => void) => {
      closeHandlers.add(handler)
      return () => closeHandlers.delete(handler)
    },
    close: () => {
      for (const handler of [...closeHandlers]) handler()
    },
    send: (msg: ClientMsg) => sent.push(msg)
  }
  return { client: client as unknown as HoustonClient, raw: client, handlers, closeHandlers, sent }
}

function exportArgs() {
  return {
    workspace: '/w',
    destination: '/tmp/w.houston-transfer',
    overwrite: false,
    passphrase: 'correct horse battery staple',
    grids: '{}'
  }
}

describe('transfer requests', () => {
  it('settles a pending request and unsubscribes when the connection closes', async () => {
    const { client, handlers, closeHandlers, sent } = fakeClient()

    const pending = exportTransfer(client, exportArgs())
    expect(sent).toHaveLength(1)
    expect(handlers.size).toBe(1)
    expect(closeHandlers.size).toBe(1)

    client.close()

    const reply = await pending
    expect(reply.kind).toBe('error')
    if (reply.kind === 'error') {
      expect(reply.message).toContain('connection to Houston was lost')
      expect(reply.message).toContain('may have completed or been undone')
      expect(reply.message).toContain('check the workspace before trying again')
    }
    expect(handlers.size).toBe(0)
    expect(closeHandlers.size).toBe(0)
  })

  it('does not settle twice when a late reply arrives after the connection closed', async () => {
    const { client, handlers, sent } = fakeClient()
    const pending = exportTransfer(client, exportArgs())
    const request = sent[0]
    if (request.type !== 'transfer_export') throw new Error('not an export')
    const late: ServerMsg = { type: 'transfer_exported', request: request.request, summary: { transfer_id: 't', file: '/tmp/w', bytes: 1, panes: [], skipped: [], skipped_links: [] } }

    client.close()
    for (const handler of [...handlers]) handler(late)

    const reply = await pending
    expect(reply.kind).toBe('error')
    expect(handlers.size).toBe(0)
  })

  it('settles concurrent requests on one close and leaves no subscriber behind', async () => {
    const { client, handlers, closeHandlers } = fakeClient()
    const first = exportTransfer(client, exportArgs())
    const second = exportTransfer(client, { ...exportArgs(), destination: '/tmp/other.houston-transfer' })
    expect(closeHandlers.size).toBe(2)

    client.close()

    const replies = await Promise.all([first, second])
    expect(replies.map((reply) => reply.kind)).toEqual(['error', 'error'])
    expect(handlers.size).toBe(0)
    expect(closeHandlers.size).toBe(0)
  })

  it('a request that settled normally leaves no subscriber', async () => {
    const { client, handlers, closeHandlers, sent } = fakeClient()
    const pending = exportTransfer(client, exportArgs())
    const request = sent[0]
    if (request.type !== 'transfer_export') throw new Error('not an export')
    const summary = { transfer_id: 't', file: '/tmp/w', bytes: 1, panes: [], skipped: [], skipped_links: [] }

    for (const handler of [...handlers]) handler({ type: 'transfer_exported', request: request.request, summary })

    const reply = await pending
    expect(reply.kind).toBe('ok')
    expect(handlers.size).toBe(0)
    expect(closeHandlers.size).toBe(0)
  })
})
