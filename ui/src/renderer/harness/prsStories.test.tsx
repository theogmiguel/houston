// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { STORIES } from './stories'

const mounted: { host: HTMLDivElement; root: Root }[] = []

afterEach(() => {
  for (const { host, root } of mounted.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
})

async function show(name: string, expected: string): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  mounted.push({ host, root })
  const Story = STORIES[name]
  await act(async () => {
    root.render(<Story />)
    await Promise.resolve()
  })
  await vi.waitFor(() => expect(document.body.textContent).toContain(expected))
  return host
}

it('renders a prs/* story from a pr_detail reply the daemon can send', async () => {
  const host = await show('prs/detail-summary-470', 'terminals keep their content')
  expect(host.querySelector('[data-testid="pr-message"]')).toBeNull()
})

it('renders the settings and transfer stories from the replies the daemon sends', async () => {
  const settings = await show('settings/agents-clis', 'Claude Code accounts')
  expect(settings.textContent).toContain('CLIs')
  await show('transfer/import', 'Import transfer')
  expect(document.body.textContent).toContain('Exported from')
})
