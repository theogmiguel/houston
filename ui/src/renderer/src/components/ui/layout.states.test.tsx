// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Card, EmptyState, Field, PageFrame, PageHeader, PaneHeaderButton, SectionHead, Segmented, Select, StatusLabel } from './index'
import { IconClose, IconSearch } from '../icons'

// @ts-expect-error pane header icon buttons require an accessible name
const unnamedPaneButton = <PaneHeaderButton icon={IconClose} />
void unnamedPaneButton

describe('page and content primitives', () => {
  it('composes frame widths from the settings column constants', () => {
    const { rerender } = render(<PageFrame><div>Form</div></PageFrame>)
    expect(screen.getByRole('main').className).toContain('max-w-[720px]')
    rerender(<PageFrame width="wide"><div>Wide</div></PageFrame>)
    expect(screen.getByRole('main').className).toContain('max-w-[1040px]')
    expect(screen.getByRole('main').className).toContain('overflow-y-auto')
  })

  it('renders page title, optional description, end actions and count', () => {
    render(<PageHeader heading="Tasks" description="Work with agents." count={2} actions={<button>New task</button>} />)
    expect(screen.getByRole('heading', { name: 'Tasks2' })).toBeTruthy()
    expect(screen.getByText('Work with agents.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New task' })).toBeTruthy()
  })

  it('keeps section count beside its label and action at the end', () => {
    render(<SectionHead title="Your turn" count={2} action={<button>Filter</button>} />)
    const heading = screen.getByRole('heading', { name: 'Your turn2Filter' })
    expect(heading.className).toContain('items-center')
    expect(heading.querySelector('button')?.textContent).toBe('Filter')
  })

  it('wires Field label, hint and error to its control', () => {
    const { rerender, container } = render(<Field label="Workspace" hint="Choose a folder."><input /></Field>)
    const control = container.querySelector('input') as HTMLInputElement
    expect(control.getAttribute('aria-describedby')).toBeTruthy()
    expect(control.getAttribute('aria-invalid')).toBeNull()
    rerender(<Field label="Workspace" hint="Choose a folder." error="A folder is required."><input /></Field>)
    expect(control.getAttribute('aria-invalid')).toBe('true')
    expect(control.getAttribute('aria-describedby')).toBeTruthy()
    expect(screen.getByText('A folder is required.')).toBeTruthy()
    expect(screen.queryByText('Choose a folder.')).toBeNull()
  })

  it('wraps Select and Segmented in the labelled Field group', () => {
    const { container } = render(
      <>
        <Field label="Workspace"><Select value="one" options={[{ value: 'one', label: 'One' }]} onChange={() => {}} aria-label="Workspace selector" /></Field>
        <Field label="Schedule"><Segmented aria-label="Schedule choice" options={[{ value: 'daily', label: 'Daily' }]} /></Field>
      </>
    )
    expect(within(container).getByRole('group', { name: 'Workspace' })).toBeTruthy()
    expect(within(container).getByRole('group', { name: 'Schedule' })).toBeTruthy()
  })

  it('renders panel and window empty states with at most one primary action', () => {
    const onClick = vi.fn()
    const { rerender, container } = render(<EmptyState icon={IconSearch} heading="No results" description="Try another search." action={{ label: 'Clear search', onClick }} />)
    expect(screen.getByRole('heading', { name: 'No results' })).toBeTruthy()
    screen.getByRole('button', { name: 'Clear search' }).click()
    expect(onClick).toHaveBeenCalledOnce()
    rerender(<EmptyState icon={IconSearch} heading="No workspace" description="Choose a workspace to get started." variant="window" />)
    expect(container.querySelector('button')).toBeNull()
  })

  it('renders grouped card rows with title, meta and trailing status/action', () => {
    render(<Card><Card.Row heading="Rename title" meta="HOU-45 · Claude Code" status={<StatusLabel status="Idle" />} action={<button>Answer</button>} /></Card>)
    expect(screen.getByText('Rename title')).toBeTruthy()
    expect(screen.getByText('HOU-45 · Claude Code')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Answer' })).toBeTruthy()
    expect(screen.getByLabelText('Idle').firstElementChild?.getAttribute('style')).toContain('transparent')
  })

  it('spans a review group heading and its rows with one status rail', () => {
    const { container } = render(<Card><Card.Group rail="gone"><SectionHead title="Gone" count={1} /><Card.Row heading="Fixed issue" /></Card.Group></Card>)
    const group = container.querySelector('section')
    const row = container.querySelector('.overflow-hidden > section > div')
    expect(group?.className).toContain('before:bg-[var(--ok)]')
    expect(row?.className).not.toContain('before:')
    expect(screen.getByRole('heading', { name: 'Gone1' })).toBeTruthy()
  })

  it('requires and forwards the pane header button accessible name', () => {
    render(<PaneHeaderButton icon={IconClose} aria-label="Close pane" />)
    expect(screen.getByRole('button', { name: 'Close pane' }).className).toContain("after:h-[28px]")
  })
})
