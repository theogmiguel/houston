// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SkillsSurface } from './SkillsSurface'

const SKILL_PATH = '/home/t/.claude/skills/impeccable/SKILL.md'
const BODY = '# Impeccable\n\nRead the interface before changing it.'

const allowed = new Set<string>()

vi.mock('../../houston/bridge', () => ({
  listSkills: vi.fn(() =>
    Promise.resolve([
      {
        agent: 'claude',
        source: 'user',
        name: 'impeccable',
        path: SKILL_PATH,
        invoke: '/impeccable',
        description: 'Design, redesign, critique and polish a frontend interface.'
      }
    ])
  ),
  writeSkill: vi.fn(),
  deleteSkill: vi.fn(),
  addAllowedRoot: vi.fn((path: string) => {
    allowed.add(path)
    return Promise.resolve()
  }),
  readFile: vi.fn((path: string) =>
    allowed.has(path)
      ? Promise.resolve(BODY)
      : Promise.reject(new Error(`${path} is outside every open workspace root`))
  )
}))

function noop(): void {}

describe('a skill with a body shows it in the Instructions box', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    allowed.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  async function settle(selector: string): Promise<Element> {
    for (let i = 0; i < 80; i++) {
      const found = container.querySelector(selector)
      if (found) return found
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5))
      })
    }
    throw new Error(`nothing matched ${selector}`)
  }

  it('reads the SKILL.md of a user-scope skill, which no workspace root covers', async () => {
    act(() => {
      root.render(
        <SkillsSurface
          tools={null}
          pushes={[]}
          autoPushEnabled={false}
          onRefresh={noop}
          onPush={noop}
          onPushUndo={noop}
          onAutoPushSet={noop}
        />
      )
    })
    const item = (await settle('[data-testid="list-detail-item"]')) as HTMLButtonElement
    act(() => item.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    const box = await settle('[data-testid="skill-instructions"][data-state="ready"]')
    expect(box.textContent).toBe(BODY)
  })
})
