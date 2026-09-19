// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsView } from './SettingsView'
import { setSettingsNavForTests } from '../settingsNav'
import { baseSettingsViewProps } from './settingsViewTestFixtures'
import {
  COMMAND_HISTORY_IGNORE_GLOBS_MAX,
  COMMAND_HISTORY_IGNORE_GLOB_LEN_MAX
} from '../houston/generated/DEFAULTS'

function openPrivacy(): void {
  act(() => setSettingsNavForTests({ section: 'privacy' }))
}

function editButton(container: HTMLDivElement): HTMLButtonElement {
  return container.querySelector('[data-testid="settings-history-ignore-edit"]') as HTMLButtonElement
}

function textarea(container: HTMLDivElement): HTMLTextAreaElement {
  return container.querySelector('[data-testid="settings-history-ignore-textarea"]') as HTMLTextAreaElement
}

function typeInto(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('Settings › Privacy — History ignore patterns (settings-59)', () => {
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

  it('shows a pre-answer label while historyIgnoreGlobs is null, and the count once it answers', () => {
    act(() => {
      root.render(<SettingsView {...baseSettingsViewProps()} historyIgnoreGlobs={null} />)
    })
    openPrivacy()
    expect(editButton(container).textContent).toBe('Edit patterns…')

    act(() => {
      root.render(
        <SettingsView
          {...baseSettingsViewProps()}
          historyIgnoreGlobs={['aws configure*', 'ssh-keygen*']}
        />
      )
    })
    expect(editButton(container).textContent).toBe('Edit 2 patterns…')
  })

  it('does not throw when the prop is undefined (App.tsx has not wired it yet)', () => {
    const props = baseSettingsViewProps()
    // @ts-expect-error — simulating the not-yet-wired caller on purpose.
    delete props.historyIgnoreGlobs
    expect(() => {
      act(() => {
        root.render(<SettingsView {...props} />)
      })
      openPrivacy()
    }).not.toThrow()
    expect(editButton(container).textContent).toBe('Edit patterns…')
  })

  it('opens an editor seeded with the current patterns, one per line', () => {
    act(() => {
      root.render(
        <SettingsView
          {...baseSettingsViewProps()}
          historyIgnoreGlobs={['aws configure*', 'ssh-keygen*']}
        />
      )
    })
    openPrivacy()
    act(() => editButton(container).click())
    expect(textarea(container).value).toBe('aws configure*\nssh-keygen*')
  })

  it('Save sends the trimmed, non-empty lines as the new list', () => {
    const sent: string[][] = []
    act(() => {
      root.render(
        <SettingsView
          {...baseSettingsViewProps()}
          historyIgnoreGlobs={[]}
          onHistoryIgnoreGlobsSet={(globs) => sent.push(globs)}
        />
      )
    })
    openPrivacy()
    act(() => editButton(container).click())
    typeInto(textarea(container), 'aws configure*\n\n  ssh-keygen*  \n')
    const save = container.querySelector('[data-testid="settings-history-ignore-save"]') as HTMLButtonElement
    act(() => save.click())
    expect(sent).toEqual([['aws configure*', 'ssh-keygen*']])
  })

  it('Cancel discards the draft without calling onHistoryIgnoreGlobsSet', () => {
    const sent: string[][] = []
    act(() => {
      root.render(
        <SettingsView
          {...baseSettingsViewProps()}
          historyIgnoreGlobs={['kept*']}
          onHistoryIgnoreGlobsSet={(globs) => sent.push(globs)}
        />
      )
    })
    openPrivacy()
    act(() => editButton(container).click())
    typeInto(textarea(container), 'discarded*')
    const cancel = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Cancel')!
    act(() => cancel.click())
    expect(sent).toEqual([])
    expect(container.querySelector('[data-testid="settings-history-ignore-textarea"]')).toBeNull()
    act(() => editButton(container).click())
    expect(textarea(container).value).toBe('kept*')
  })

  it('shows the daemon-authoritative caps as a live readout, not a client-side clamp', () => {
    act(() => {
      root.render(<SettingsView {...baseSettingsViewProps()} historyIgnoreGlobs={[]} />)
    })
    openPrivacy()
    act(() => editButton(container).click())
    expect(container.textContent).toContain(`0/${COMMAND_HISTORY_IGNORE_GLOBS_MAX} patterns`)
    typeInto(textarea(container), 'a\nbb\nccc')
    expect(container.textContent).toContain(`3/${COMMAND_HISTORY_IGNORE_GLOBS_MAX} patterns`)
    expect(container.textContent).toContain(`3/${COMMAND_HISTORY_IGNORE_GLOB_LEN_MAX} chars`)
  })
})
