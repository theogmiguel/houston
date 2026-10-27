import { describe, expect, it, vi } from 'vitest'
import { HoustonClient } from './client'

describe('task review and review-request protocol messages', () => {
  it('sends the review mode and focus with the existing reviewer and rework rounds', () => {
    const client = Object.create(HoustonClient.prototype) as HoustonClient
    const send = vi.spyOn(client, 'send').mockImplementation(() => {})

    client.taskReviewSettingsSet('/workspace', 'codex', 2, 'every_push', 'security')

    expect(send).toHaveBeenCalledWith({
      type: 'task_review_settings_set',
      workspace: '/workspace',
      reviewer: 'codex',
      rework_rounds: 2,
      mode: 'every_push',
      focus: 'security'
    })
  })

  it('sends the review-request reads and decisions', () => {
    const client = Object.create(HoustonClient.prototype) as HoustonClient
    const send = vi.spyOn(client, 'send').mockImplementation(() => {})

    client.reviewRequestsGet()
    client.reviewRequestsSet('notify')
    client.reviewRequestDismiss(7)
    client.reviewRequestReopen(7)

    expect(send.mock.calls.map(([message]) => message)).toEqual([
      { type: 'review_requests_get' },
      { type: 'review_requests_set', mode: 'notify' },
      { type: 'review_request_dismiss', id: 7 },
      { type: 'review_request_reopen', id: 7 }
    ])
  })
})
