// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NightShiftSetup } from './NightShiftSetup'
import { nightDefaults } from '../../test/nightShiftFixtures'
import type { NightDetected } from '../../houston/generated/NightDetected'
import type { NightShiftSettings } from '../../houston/generated/NightShiftSettings'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const CHECKS: NightShiftSettings['checks'] = [
  { command: 'cargo fmt --all --check', source: 'ci.yml · core-checks' },
  { command: 'cd ui && bun run typecheck', source: 'ci.yml · renderer-checks' }
]
const DETECTED: NightDetected = {
  checks: CHECKS,
  start_command: { command: 'node ui/harness/shot.mjs <story> <out.png>', source: 'ui/harness/shot.mjs' },
  apps: [{ name: 'Orca', version: '1.4.238', path: 'C:\\Programs\\orca\\Orca.exe' }],
  apps_note: null
}
const ready = (): NightShiftSettings => ({ ...nightDefaults(), checks: CHECKS })

function render(settings: NightShiftSettings, props: Partial<Parameters<typeof NightShiftSetup>[0]> = {}): { onSave: ReturnType<typeof vi.fn>; onRunNow: ReturnType<typeof vi.fn> } {
  const onSave = vi.fn()
  const onRunNow = vi.fn()
  act(() => root.render(<NightShiftSetup settings={settings} revision="r" verifyCommand={false} detected={DETECTED} onSave={onSave} onRunNow={onRunNow} {...props} />))
  return { onSave, onRunNow }
}

const q = <T extends Element = HTMLElement>(sel: string): T | null => host.querySelector<T>(sel)
const click = (el: Element | null | undefined): void => {
  if (!el) throw new Error('missing element')
  act(() => { (el as HTMLElement).click() })
}
const button = (text: string): HTMLButtonElement | undefined =>
  Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === text)
const toggle = (label: string): HTMLElement | null => q(`[role="switch"][aria-label="${label}"]`)
const radio = (group: string, text: string): Element | undefined =>
  Array.from(host.querySelectorAll(`[role="radiogroup"][aria-label="${group}"] [role="radio"]`)).find((b) => b.textContent?.includes(text))
const checked = (group: string): string | null =>
  q(`[role="radiogroup"][aria-label="${group}"] [aria-checked="true"]`)?.textContent ?? null
const type = (label: string, value: string): void => {
  const el = q<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!
  act(() => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
const question = (title: string): HTMLElement =>
  Array.from(host.querySelectorAll<HTMLElement>('section[aria-labelledby]')).find((s) => s.querySelector('h2')?.textContent === title)!
const badge = (title: string): string | null | undefined => question(title).querySelector('[data-testid="night-question-badge"]')?.textContent
const readiness = (): string | null | undefined => q('[data-testid="night-readiness"]')?.textContent
const openDisclosure = (text: string): void =>
  click(Array.from(host.querySelectorAll<HTMLButtonElement>('[data-testid="disclosure"] > * button, [data-testid="disclosure"] button[aria-expanded]')).find((b) => b.textContent?.startsWith(text)))

describe('NightShiftSetup', () => {
  it('asks the four questions with defaults and says what a run still needs', () => {
    render(nightDefaults())
    expect(q('h1')?.textContent).toBe('Set up Night shift')
    expect(Array.from(host.querySelectorAll('section h2')).map((h) => h.textContent)).toEqual([
      'What should it work on?', 'How do I know a change is good?', 'What do I get back?', 'When does it run?'
    ])
    expect(badge('What should it work on?')).toBe('Answered')
    expect(q('[role="radiogroup"][aria-label="Reliability attention"]')).not.toBeNull()
    expect(q('[role="radiogroup"][aria-label="UI and UX polish attention"]'), 'Low/Normal/High only for an area that is on').toBeNull()
    expect(q('button[aria-label="About Reliability"]')).not.toBeNull()
    expect(badge('How do I know a change is good?')).toBe('Required')
    expect(host.textContent, 'never "No checks found" when detection found some').toContain('None chosen, 2 found in the repository')
    expect(host.textContent).not.toContain('No checks found')
    expect(q('[role="group"][aria-label="App QA"]')?.textContent).toContain('Off')
    expect(checked('Output')).toContain('Draft pull requests')
    expect(toggle('Hold for my QA'), 'Hold for my QA only under Merge queue').toBeNull()
    expect(host.textContent).toContain('Off: it runs only when you choose Run now.')
    expect(q('[role="group"][aria-label="Nights"]')).toBeNull()
    expect(host.textContent).toContain('Claude Code orchestrator · ZCode, then Claude Code workers · 4 at a time')
    expect(readiness()).toBe('To run, add a repository check.')
    expect(button('Run now…')?.disabled).toBe(true)
  })

  it('is ready to run with checks found in the repository, and Run now opens preflight', () => {
    const { onRunNow } = render(ready())
    expect(badge('How do I know a change is good?')).toBe('Answered from the repository')
    const summary = button('2 checks from ci.yml ▸')
    expect(summary, 'the list is collapsed behind its summary').toBeDefined()
    expect(q('[role="group"][aria-label="Repository checks"]')).toBeNull()
    click(summary)
    const list = q('[role="group"][aria-label="Repository checks"]')!
    expect(list.textContent).toContain('cd ui && bun run typecheck')
    expect(list.textContent).toContain('ci.yml · renderer-checks')
    expect(readiness()).toBe('Ready to run.')
    click(button('Run now…'))
    expect(onRunNow).toHaveBeenCalled()
    click(q('button[aria-label="Remove cargo fmt --all --check"]'))
    expect(readiness()).toBe('To run, save your changes.')
    expect(button('Run now…')?.disabled).toBe(true)
  })

  it('reveals competitor rows for Competitor gaps and saves validated entries', () => {
    const { onSave } = render(ready())
    expect(q('[role="group"][aria-label="Competitors"]')).toBeNull()
    click(toggle('Competitor gaps on'))
    expect(q('[role="group"][aria-label="Competitors"]')).not.toBeNull()
    click(button('Add competitor'))
    type('Competitor 1 repository', 'https://github.com/pingdotgg/t3code.git')
    expect(host.textContent).toContain('pingdotgg/t3code · cloned read-only')
    click(button('Add competitor'))
    click(radio('Competitor 2 kind', 'Installed app'))
    expect(host.textContent).toContain('Choose an app installed on this computer.')
    expect(host.textContent).toContain('Complete or remove the unfinished competitor.')
    expect(host.textContent).toContain('Make sure the app\'s licence allows analysing it.')
    click(q('button[aria-label="Remove competitor 2"]'))
    click(button('Save'))
    expect(onSave.mock.calls[0][0].competitors).toEqual([{ kind: 'repo', repo: 'pingdotgg/t3code' }])
    expect(onSave.mock.calls[0][0].focus.competitor_gaps).toBe('normal')
  })

  it('keeps Screenshots on while UI and UX polish is on and points to App QA', () => {
    render({ ...ready(), screenshots: false })
    click(toggle('UI and UX polish on'))
    expect(host.textContent).toContain('Changes here are visible, so Screenshots stays on while this is on.')
    expect(host.textContent).toContain('Turn on App QA, step 5 in question 2')
    openDisclosure('Pull request format')
    const shots = toggle('Screenshots')!
    expect([shots.getAttribute('aria-checked'), (shots as HTMLButtonElement).disabled]).toEqual(['true', true])
    expect(host.textContent).toContain('On while UI and UX polish is on')
  })

  it('suggests focus areas from the direction without overriding one set by hand', () => {
    render(ready())
    click(toggle('Docs accuracy on'))
    type('Direction', 'Make it feel faster')
    expect(host.textContent).toContain('Suggested from your direction')
    expect(checked('Performance attention')).toBe('High')
    expect(toggle('Reliability on')?.getAttribute('aria-checked')).toBe('false')
    expect(toggle('Docs accuracy on')?.getAttribute('aria-checked'), 'changed by hand').toBe('true')
    type('Direction', '')
    expect(host.textContent).not.toContain('Suggested from your direction')
    expect(toggle('Reliability on')?.getAttribute('aria-checked')).toBe('true')
  })

  it('reveals Merge queue requirements and Hold for my QA, keeping the value under Draft pull requests', () => {
    const { onSave } = render(ready())
    click(radio('Output', 'Merge queue'))
    const refusal = q('[data-testid="merge-refusal"]')?.textContent
    expect(refusal).toContain('verification command')
    expect(refusal).toContain('App QA on with a start command')
    click(toggle('Hold for my QA'))
    click(radio('Output', 'Draft pull requests'))
    expect(toggle('Hold for my QA')).toBeNull()
    click(button('Save'))
    expect(onSave.mock.calls[0][0].hold_for_qa).toBe(false)
  })

  it('lays out both Output cards the same, the content stretched to the card padding', () => {
    render(ready())
    const content = ['Draft pull requests', 'Merge queue'].map((t) => radio('Output', t)?.firstElementChild?.className ?? '')
    // The card is a .btn, which centres its children; content narrower than the card would drift inwards.
    expect(content[0], 'a short description must not centre the content').toContain('w-full')
    expect(content[1]).toBe(content[0])
  })

  it('turns App QA on with the start command found in the repository', () => {
    render(ready())
    const step = (): string => q('[role="group"][aria-label="App QA"]')?.textContent ?? ''
    click(toggle('App QA on'))
    expect(step()).toContain('On')
    expect(q<HTMLInputElement>('input[aria-label="Start command"]')?.value).toBe('node ui/harness/shot.mjs <story> <out.png>')
    expect(step()).toContain('ui/harness/shot.mjs')
    type('Start command', '')
    expect(step()).toContain('Needs a start command')
    expect(q<HTMLInputElement>('input[aria-label="What to open"]')?.disabled).toBe(true)
    const open = q<HTMLInputElement>('input[aria-label="What to open"]')!
    expect(open.value, 'empty by default: the per-change behaviour is a placeholder').toBe('')
    expect(open.placeholder).toBe('Per change: the story or screen it touches')
    expect(open.className, 'a placeholder in the field font, not a typed-looking command').not.toContain('font-mono')
    expect(open.className).toContain('placeholder:text-[var(--text-faint)]')
    expect(step()).toContain('App QA stays off until you do.')
  })

  it('shows the schedule only when it is on and the own pane limit only above the global cap', () => {
    render(ready(), { childCap: 6 })
    click(toggle('Run on a schedule'))
    expect(host.textContent).toContain('Pick at least one night.')
    click(button('Tue'))
    expect(host.textContent).toContain('Runs on 1 night a week.')
    expect(host.textContent).toContain('8 h · nothing new starts after wrap-up')
    openDisclosure('Advanced')
    expect(host.textContent).not.toContain('Own limit')
    type('Workers at a time', '5')
    expect(host.textContent).toContain('Own limit: 7 panes · other agents keep 6')
  })

  it('keeps an edit across refreshes and saves it against the revision it was read at', () => {
    const onSave = vi.fn()
    const at = (revision: string, direction = ''): void =>
      act(() => root.render(<NightShiftSetup settings={{ ...ready(), direction }} revision={revision} verifyCommand onSave={onSave} />))
    at('r')
    type('Direction', 'CI is green')
    at('r')
    expect(q<HTMLTextAreaElement>('[aria-label="Direction"]')?.value).toBe('CI is green')
    at('r2', 'from another window')
    expect(q<HTMLTextAreaElement>('[aria-label="Direction"]')?.value).toBe('CI is green')
    click(button('Save'))
    expect(onSave.mock.calls[0][1]).toBe('r')
    click(button('Discard changes'))
    expect(q<HTMLTextAreaElement>('[aria-label="Direction"]')?.value).toBe('from another window')
  })

  it('confirms a save once the daemon answers with the saved settings', () => {
    const onSave = vi.fn()
    const at = (settings: NightShiftSettings, revision: string, error: string | null = null): void =>
      act(() => root.render(<NightShiftSetup settings={settings} revision={revision} verifyCommand onSave={onSave} error={error} />))
    at(ready(), 'r')
    const status = (): string => q('[role="status"]')?.textContent ?? ''
    type('Direction', 'CI is green')
    click(button('Save'))
    expect(status()).toContain('Saving')
    at({ ...ready(), direction: 'CI is green' }, 'r2')
    expect(status()).toContain('Saved')
    type('Direction', 'CI is green, docs too')
    expect(status()).toBe('')
    click(button('Save'))
    at({ ...ready(), direction: 'CI is green' }, 'r2', 'stale revision')
    expect(status(), 'a refused save is not confirmed').toBe('')
  })

  it('offers no ZCode orchestrator and refuses a stored one by its reason', () => {
    render(ready())
    openDisclosure('Advanced')
    const trigger = q('[role="combobox"][aria-label="Orchestrator"]')!
    act(() => { trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })) })
    const menu = document.getElementById(trigger.getAttribute('aria-controls')!)!
    expect(Array.from(menu.querySelectorAll<HTMLElement>('[role="option"]')).map((o) => o.dataset.value)).toEqual(['claude', 'codex', 'opencode'])
    act(() => root.render(<NightShiftSetup settings={{ ...ready(), orchestrator: { provider: 'zcode', model: null } }} revision="r2" verifyCommand onSave={vi.fn()} />))
    expect(host.textContent).toContain('ZCode cannot orchestrate: a pull request watch cannot wake it')
  })
})
