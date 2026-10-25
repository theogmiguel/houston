import { describe, expect, it, vi } from 'vitest'
import type { HoustonClient } from './client'
import type { ClientMsg } from './generated/ClientMsg'
import type { ServerMsg } from './generated/ServerMsg'
import { exportTransfer } from './transfer'

function fakeClient() {
  const handlers = new Set<(msg: ServerMsg) => void>()
  const sent: ClientMsg[] = []
  const client = {
    onClose: () => {},
    subscribeAll: (handler: (msg: ServerMsg) => void) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    send: (msg: ClientMsg) => sent.push(msg)
  }
  return { client: client as unknown as HoustonClient, raw: client, handlers, sent }
}

describe('transfer requests', () => {
  it('settles a pending request and unsubscribes when the connection closes', async () => {
    const { client, raw, handlers, sent } = fakeClient()
    const prior = vi.fn()
    raw.onClose = prior

    const pending = exportTransfer(client, {
      workspace: '/w',
      destination: '/tmp/w.houston-transfer',
      overwrite: false,
      passphrase: 'correct horse battery staple',
      grids: '{}'
    })
    expect(sent).toHaveLength(1)
    expect(handlers.size).toBe(1)

    raw.onClose()

    const reply = await pending
    expect(reply.kind).toBe('error')
    if (reply.kind === 'error') {
      expect(reply.message).toContain('connection to Houston was lost')
      expect(reply.message).toContain('may have completed or been undone')
      expect(reply.message).toContain('check the workspace before trying again')
    }
    expect(prior).toHaveBeenCalledTimes(1)
    expect(handlers.size).toBe(0)
    expect(raw.onClose).toBe(prior)
  })

  it('does not settle twice when a late reply arrives after the connection closed', async () => {
    const { client, raw, handlers, sent } = fakeClient()
    const pending = exportTransfer(client, {
      workspace: '/w',
      destination: '/tmp/w.houston-transfer',
      overwrite: false,
      passphrase: 'correct horse battery staple',
      grids: '{}'
    })
    const request = sent[0]
    if (request.type !== 'transfer_export') throw new Error('not an export')
    const late: ServerMsg = { type: 'transfer_exported', request: request.request, summary: { transfer_id: 't', file: '/tmp/w', bytes: 1, panes: [], skipped: [], skipped_links: [] } }

    raw.onClose()
    for (const handler of [...handlers]) handler(late)

    const reply = await pending
    expect(reply.kind).toBe('error')
    expect(handlers.size).toBe(0)
  })
})
