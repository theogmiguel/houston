import { describe, expect, it, vi } from 'vitest'
import { HoustonClient } from './client'

describe('suspected defect protocol messages', () => {
  it('sends the defect list, decision and draft requests in the wire shape', () => {
    const client = Object.create(HoustonClient.prototype) as HoustonClient
    const send = vi.spyOn(client, 'send').mockImplementation(() => {})

    client.defectsGet('/workspace')
    client.defectDecide('/workspace', 'repeated-refusal', 'not_a_bug')
    client.defectIssueDraft('/workspace', 'repeated-refusal', 4)

    expect(send.mock.calls.map(([message]) => message)).toEqual([
      { type: 'defects_get', workspace: '/workspace' },
      { type: 'defect_decide', workspace: '/workspace', key: 'repeated-refusal', decision: 'not_a_bug' },
      { type: 'defect_issue_draft', workspace: '/workspace', key: 'repeated-refusal', request: 4 }
    ])
  })

  it('files an issue or a comment only through the explicit message', () => {
    const client = Object.create(HoustonClient.prototype) as HoustonClient
    const send = vi.spyOn(client, 'send').mockImplementation(() => {})

    client.defectIssueFile('/workspace', 'repeated-refusal', 5, 'A title', 'A body', 'acme/houston')
    client.defectIssueFile('/workspace', 'repeated-refusal', 6, 'A title', 'A body', 'acme/houston', 42)

    expect(send.mock.calls.map(([message]) => message)).toEqual([
      {
        type: 'defect_issue_file',
        workspace: '/workspace',
        key: 'repeated-refusal',
        request: 5,
        title: 'A title',
        body: 'A body',
        destination_repo: 'acme/houston',
        comment_on: null
      },
      {
        type: 'defect_issue_file',
        workspace: '/workspace',
        key: 'repeated-refusal',
        request: 6,
        title: 'A title',
        body: 'A body',
        destination_repo: 'acme/houston',
        comment_on: 42
      }
    ])
  })
})
