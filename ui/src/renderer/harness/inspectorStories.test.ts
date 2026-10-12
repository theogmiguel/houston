// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { InspectorClient } from './inspectorStories'

describe('pull request capture fixtures', () => {
  it('returns the selected failing pull request own branch and checks', async () => {
    const client = new InspectorClient(false, false, { number: 93, state: 'open' })
    const message = await new Promise<Record<string, unknown>>((resolve) => {
      client.subscribe('pr_detail', (value) => resolve(value as unknown as Record<string, unknown>))
      client.prDetail('/repo', 93)
    })
    const link = message.link as { number: number; checks: string }
    const detail = message.detail as { head_ref: string; checks: { name: string; state: string }[] }
    expect(link.number).toBe(93)
    expect(link.checks).toBe('failing')
    expect(detail.head_ref).toBe('fix/codex-native-startup')
    expect(detail.checks.some((check) => check.state === 'failing')).toBe(true)
  })
})
