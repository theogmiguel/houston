// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { NoticeStack } from './NoticeStack'
import { resolveNotice, type NoticeRecord } from '../notices'

afterEach(cleanup)

const rec = (over: Partial<NoticeRecord> & { code: string; title: string }): NoticeRecord => ({
  ...resolveNotice(over, over.code.length),
  ...over
})

const store = (notices: NoticeRecord[], evicted = 0): Parameters<typeof NoticeStack>[0]['store'] => ({
  notices,
  evicted,
  push: () => '',
  dismiss: vi.fn()
})

describe('NoticeStack placement', () => {
  it('anchors the workspace stack top-centre at the reference geometry', () => {
    render(<NoticeStack anchor="workspace-top" label="Workspace notices" store={store([rec({ code: 'a', title: 'hello' })])} />)
    const section = screen.getByLabelText('Workspace notices')
    expect(section.className).toContain('top-[8px]')
    expect(section.className).toContain('left-1/2')
    expect(section.className).toContain('w-[min(560px,100%-24px)]')
    expect(section.className).toContain('pointer-events-none')
    expect(screen.getByText('hello').closest('[data-notice]')?.className).toContain('pointer-events-auto')
  })

  it('anchors the pane stack in the corner it lives in, growing upward', () => {
    render(<NoticeStack anchor="pane-corner" label="Pane notices" store={store([rec({ code: 'a', title: 'hi' })])} />)
    const section = screen.getByLabelText('Pane notices')
    expect(section.className).toContain('bottom-[12px]')
    expect(section.className).toContain('right-[12px]')
    expect(section.className).toContain('flex-col-reverse')
    expect(section.className).toContain('items-end')
  })

  it('renders the newest row last in DOM order', () => {
    render(
      <NoticeStack
        anchor="workspace-top"
        label="Workspace notices"
        store={store([rec({ code: 'a', title: 'older' }), rec({ code: 'b', title: 'newer' })])}
      />
    )
    const rows = screen.getByLabelText('Workspace notices').querySelectorAll('[data-notice]')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('older')
    expect(rows[1].textContent).toContain('newer')
  })

  it('renders nothing at all when the stack is empty', () => {
    render(<NoticeStack anchor="workspace-top" label="Workspace notices" store={store([])} />)
    expect(screen.queryByLabelText('Workspace notices')).toBeNull()
  })
})

describe('NoticeStack rows', () => {
  it('gives an error row role=alert and every other kind role=status', () => {
    render(
      <NoticeStack
        anchor="workspace-top"
        label="Workspace notices"
        store={store([rec({ code: 'e', title: 'boom', kind: 'error' }), rec({ code: 'i', title: 'fyi', kind: 'info' })])}
      />
    )
    expect(screen.getByRole('alert').textContent).toContain('boom')
    expect(screen.getByRole('status').textContent).toContain('fyi')
  })

  it('tints an error row with the danger stroke at the reference mix', () => {
    render(<NoticeStack anchor="workspace-top" label="L" store={store([rec({ code: 'e', title: 'boom', kind: 'error' })])} />)
    expect(screen.getByRole('alert').className).toContain('color-mix(in_srgb,var(--danger)_42%,transparent)')
  })

  it('dismisses by code, not by index', () => {
    const s = store([rec({ code: 'keep', title: 'keep' }), rec({ code: 'go', title: 'go' })])
    render(<NoticeStack anchor="workspace-top" label="L" store={s} />)
    act(() => {
      screen.getByLabelText('Dismiss go').click()
    })
    expect(s.dismiss).toHaveBeenCalledWith('go')
  })

  it('omits the dismiss button on a non-dismissible row', () => {
    render(
      <NoticeStack
        anchor="workspace-top"
        label="L"
        store={store([rec({ code: 'ro', title: 'read-only', dismissible: false })])}
      />
    )
    expect(screen.queryByLabelText('Dismiss read-only')).toBeNull()
  })

  it('renders a row action as a labelled button beside the copy', () => {
    const onClick = vi.fn()
    render(
      <NoticeStack
        anchor="workspace-top"
        label="L"
        store={store([rec({ code: 'save', title: 'not saved', action: { label: 'Retry save', onClick } })])}
      />
    )
    act(() => {
      screen.getByRole('button', { name: 'Retry save' }).click()
    })
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('drops the top stack in from its own edge, behind motion-safe', () => {
    render(<NoticeStack anchor="workspace-top" label="L" store={store([rec({ code: 'a', title: 'a' })])} />)
    const row = screen.getByRole('status')
    expect(row.className).toContain('motion-safe:[animation:notice-in-top_200ms')
    expect(row.className).not.toMatch(/(^|\s)\[animation:/)
  })

  it('slides a corner row in from its own edge, behind motion-safe', () => {
    render(<NoticeStack anchor="pane-corner" label="L" store={store([rec({ code: 'a', title: 'a' })])} />)
    const row = screen.getByRole('status')
    expect(row.className).toContain('motion-safe:[animation:notice-in-corner_200ms')
    expect(row.className).not.toMatch(/(^|\s)\[animation:/)
  })
})

describe('NoticeStack overflow', () => {
  it('names the cap and the count when eviction has dropped notices', () => {
    render(<NoticeStack anchor="workspace-top" label="L" store={store([rec({ code: 'a', title: 'a' })], 3)} />)
    expect(screen.getByText('3 earlier notices dropped — the stack holds 5')).toBeTruthy()
  })

  it('says nothing about overflow when nothing was evicted', () => {
    render(<NoticeStack anchor="workspace-top" label="L" store={store([rec({ code: 'a', title: 'a' })], 0)} />)
    expect(screen.queryByText(/earlier notices dropped/)).toBeNull()
  })
})
