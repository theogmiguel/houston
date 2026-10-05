// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Skill } from '../../env'
import { SkillsLeaf } from '../SkillsLeaf'

vi.mock('../../houston/bridge', () => ({
  listSkills: vi.fn(
    (): Promise<Skill[]> =>
      Promise.resolve([
        { agent: 'claude', source: 'project', name: 'deploy', path: '/p/deploy.md', invoke: '/deploy', description: '' }
      ])
  ),
  writeSkill: vi.fn(),
  deleteSkill: vi.fn(),
  readFile: vi.fn()
}))

function noop(): void {}

describe('SkillsLeaf — still has its Run control (regression, step 13)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('opens a skill and invokes onRun from its "Use in selected terminal" control', async () => {
    const onRun = vi.fn()
    act(() => {
      root.render(
        <SkillsLeaf
          node={{ kind: 'skills', id: 'skills-1' }}
          dir="/home/dev/project"
          onRun={onRun}
          onClose={noop}
          onHeaderPointerDown={noop}
        />
      )
    })
    const findByLabel = (label: string): HTMLButtonElement | undefined =>
      Array.from(container.querySelectorAll('button')).find(
        (b) => b.getAttribute('aria-label') === label
      )
    for (let i = 0; i < 60 && findByLabel('View deploy') === undefined; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5))
      })
    }
    const openRow = findByLabel('View deploy')
    expect(openRow).toBeDefined()
    act(() => {
      openRow!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    let useButton = findByLabel('Use deploy in the selected terminal')
    for (let i = 0; i < 60 && useButton === undefined; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5))
      })
      useButton = findByLabel('Use deploy in the selected terminal')
    }
    expect(useButton).toBeDefined()

    act(() => {
      useButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onRun).toHaveBeenCalledWith('/deploy')
  })
})
