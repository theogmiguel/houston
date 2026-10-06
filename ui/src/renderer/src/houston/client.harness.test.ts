import { describe, expect, it, vi } from 'vitest'
import { HoustonClient } from './client'

describe('Harness protocol messages', () => {
  it('sends fix-task, seen-cursor and overview requests in the wire shape', () => {
    const client = Object.create(HoustonClient.prototype) as HoustonClient
    const send = vi.spyOn(client, 'send').mockImplementation(() => {})

    client.harnessFixTask('/workspace', 'HOU-12', 'codex', 'Apply the reviewed change.')
    client.harnessSeen('/workspace', 17)
    client.harnessOverviewGet()

    expect(send.mock.calls.map(([message]) => message)).toEqual([
      { type: 'harness_fix_task', workspace: '/workspace', key: 'HOU-12', agent: 'codex', start: false, prompt: 'Apply the reviewed change.' },
      { type: 'harness_seen', workspace: '/workspace', review_id: 17 },
      { type: 'harness_overview_get' }
    ])
  })
})
