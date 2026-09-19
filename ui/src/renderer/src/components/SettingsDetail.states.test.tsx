// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsDetail, type SettingsRowGroup } from './SettingsDetail'

describe('SettingsDetail — state matrix', () => {
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
    vi.restoreAllMocks()
  })

  const oneGroup: SettingsRowGroup[] = [
    {
      heading: 'Preferences',
      rows: [{ id: 'r1', label: 'Some setting', control: { kind: 'node', node: <span>on</span> } }]
    }
  ]

  it('Empty — groups undefined (not loaded yet) renders a neutral placeholder, not a blank pane', () => {
    act(() => {
      root.render(<SettingsDetail title="Voice" onSave={() => {}} />)
    })
    expect(container.querySelector('[data-testid="settings-detail-empty"]')).not.toBeNull()
  })

  it('Filled — groups with rows render their heading and row label', () => {
    act(() => {
      root.render(<SettingsDetail title="Voice" groups={oneGroup} onSave={() => {}} />)
    })
    expect(container.textContent).toContain('Preferences')
    expect(container.textContent).toContain('Some setting')
  })

  it('Hover — the Save button carries hover treatment', () => {
    act(() => {
      root.render(<SettingsDetail title="Voice" groups={oneGroup} onSave={() => {}} dirty />)
    })
    expect(container.querySelector('[data-testid="settings-detail-save"]')?.className).toContain('hover:')
  })

  it('Focus — the Save button carries a visible focus ring', () => {
    act(() => {
      root.render(<SettingsDetail title="Voice" groups={oneGroup} onSave={() => {}} dirty />)
    })
    expect(container.querySelector('[data-testid="settings-detail-save"]')?.className).toContain(
      'focus-visible:shadow-'
    )
  })

  it('Active — the Save button carries a press-scale treatment', () => {
    act(() => {
      root.render(<SettingsDetail title="Voice" groups={oneGroup} onSave={() => {}} dirty />)
    })
    expect(container.querySelector('[data-testid="settings-detail-save"]')?.className).toContain('active:scale-')
  })

  it('Selected — N/A: nothing in a settings detail column is "the current choice among siblings"; rows are independent preferences, not options in a set.', () => {
    expect(true).toBe(true)
  })

  it('Disabled (+reason) — a disabled row shows its reason AND structurally blocks the control, even one that forgot to disable itself', () => {
    const onClick = vi.fn()
    const groups: SettingsRowGroup[] = [
      {
        heading: 'Terminal',
        rows: [
          {
            id: 'open-links',
            label: 'Open links in a browser pane',
            control: {
              kind: 'node',
              node: (
                <button type="button" onClick={onClick}>
                  Toggle
                </button>
              )
            },
            disable: { disabled: true, reason: 'No browser pane is open in this workspace.' }
          }
        ]
      }
    ]
    act(() => {
      root.render(<SettingsDetail title="Terminal" groups={groups} onSave={() => {}} />)
    })
    const reason = container.querySelector('[data-testid="settings-row-disabled-reason"]')
    expect(reason?.textContent).toBe('No browser pane is open in this workspace.')
    const button = container.querySelector('button') as HTMLButtonElement
    act(() => button.click())
    expect(onClick).not.toHaveBeenCalled()
    const wrapper = button.closest('[aria-disabled="true"]')
    expect(wrapper?.className).toContain('pointer-events-none')
  })

  it('Loading — shows a spinner and suppresses row content', () => {
    act(() => {
      root.render(<SettingsDetail title="Voice" groups={oneGroup} loading onSave={() => {}} />)
    })
    expect(container.querySelector('[data-testid="settings-detail-loading"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Some setting')
  })

  it('Error (+retry) — shows the message and a working Try again', () => {
    const onRetry = vi.fn()
    act(() => {
      root.render(
        <SettingsDetail title="Voice" groups={oneGroup} error={{ message: 'Daemon unreachable', onRetry }} onSave={() => {}} />
      )
    })
    expect(container.textContent).toContain('Daemon unreachable')
    const retry = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Try again')
    act(() => retry?.click())
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('Overflow — many rows still all render inside the scrolling content column, not a growing one', () => {
    const groups: SettingsRowGroup[] = [
      {
        heading: 'Keymap',
        rows: Array.from({ length: 50 }, (_, i) => ({
          id: `row-${i}`,
          label: `Action ${i}`,
          control: { kind: 'node' as const, node: <span /> }
        }))
      }
    ]
    act(() => {
      root.render(<SettingsDetail title="Shortcuts" groups={groups} onSave={() => {}} />)
    })
    expect(container.querySelectorAll('[data-testid="settings-detail-row"]').length).toBe(50)
    const scroller = container.querySelector('[data-testid="settings-detail"] > div')
    expect(scroller?.className).toContain('overflow-y-auto')
  })

  it('Empty set — groups=[] (loaded, genuinely nothing to configure) renders a distinct message from Empty', () => {
    act(() => {
      root.render(<SettingsDetail title="Voice" groups={[]} onSave={() => {}} />)
    })
    expect(container.querySelector('[data-testid="settings-detail-empty-set"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="settings-detail-empty"]')).toBeNull()
  })

  it('Destructive row requires two clicks: first arms, second confirms', () => {
    const onConfirm = vi.fn()
    const groups: SettingsRowGroup[] = [
      {
        heading: 'Danger zone',
        rows: [
          {
            id: 'clear-history',
            label: 'Command history',
            control: { kind: 'destructive', label: 'Clear…', armedLabel: 'Really clear?', onConfirm }
          }
        ]
      }
    ]
    act(() => {
      root.render(<SettingsDetail title="Privacy & data" groups={groups} onSave={() => {}} />)
    })
    const button = container.querySelector('[data-testid="settings-destructive"]') as HTMLButtonElement
    expect(button.textContent).toBe('Clear…')
    act(() => button.click())
    expect(onConfirm).not.toHaveBeenCalled()
    expect(button.textContent).toBe('Really clear?')
    act(() => button.click())
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('Sticky Save is disabled when nothing is dirty, enabled once something changed', () => {
    act(() => {
      root.render(<SettingsDetail title="Voice" groups={oneGroup} onSave={() => {}} dirty={false} />)
    })
    expect((container.querySelector('[data-testid="settings-detail-save"]') as HTMLButtonElement).disabled).toBe(true)
    act(() => {
      root.render(<SettingsDetail title="Voice" groups={oneGroup} onSave={() => {}} dirty />)
    })
    expect((container.querySelector('[data-testid="settings-detail-save"]') as HTMLButtonElement).disabled).toBe(false)
  })
})
