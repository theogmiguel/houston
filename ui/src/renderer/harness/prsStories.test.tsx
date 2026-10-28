// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { STORIES } from './stories'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

it('renders a prs/* story from a pr_detail reply the daemon can send', async () => {
  const Story = STORIES['prs/detail-summary-470']
  await act(async () => {
    root.render(<Story />)
    await Promise.resolve()
  })
  await vi.waitFor(() => expect(host.textContent).toContain('terminals keep their content'))
  expect(host.querySelector('[data-testid="pr-message"]')).toBeNull()
})
