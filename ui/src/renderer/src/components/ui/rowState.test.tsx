// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { RowStateSpecimen } from './RowStateSpecimen'
import { ROW_HIGHLIGHT, ROW_STATE } from './rowState'
import { WorkspaceTreeRow } from './WorkspaceTreeRow'

afterEach(cleanup)
function recipe(element: Element, state: string): void {
  for (const cls of state.split(' ')) expect(element.classList.contains(cls), cls).toBe(true)
  expect(element.className).not.toContain('hover:text-[var(--text-primary)]')
}

describe('shared row painting', () => {
  it('renders the same rest and selected recipe across navigation, settings, workspace, chips, files and PRs', () => {
    render(<RowStateSpecimen />)
    for (const label of ['navigation', 'settings', 'workspace', 'choice', 'file', 'pull request']) {
      recipe(screen.getByText(`Selected ${label}`).closest('button, [role="button"]')!, ROW_STATE.selected)
      recipe(screen.getByText(`Rest ${label}`).closest('button, [role="button"]')!, ROW_STATE.rest)
    }
    recipe(screen.getByRole('button', { name: 'Pressed toolbar' }), ROW_STATE.selected)
    recipe(screen.getByRole('button', { name: 'Rest toolbar' }), ROW_STATE.rest)
    const tree = screen.getByText('Selected file')
    expect(tree.className).not.toContain('bg-transparent')
    expect(tree.className).not.toContain('focus-visible:bg-')
    expect(tree.className).toContain('focus-visible:shadow-')
    expect(screen.getByText('Selected choice').closest('button')?.getAttribute('aria-pressed')).toBe('true')
  })

  it('uses neutral menu hover and a single active Select recipe with a separate current check', () => {
    render(<RowStateSpecimen />)
    for (const label of ['Context item', 'Menu item', 'Git tool item']) recipe(screen.getByText(label).closest('button')!, ROW_STATE.rest)
    const select = screen.getByRole('combobox', { name: 'Row state select' })
    fireEvent.mouseDown(select, { button: 0 })
    const options = screen.getAllByRole('option')
    recipe(options[0], ROW_HIGHLIGHT.selected)
    recipe(options[1], ROW_HIGHLIGHT.rest)
    fireEvent.mouseEnter(options[1])
    recipe(options[0], ROW_HIGHLIGHT.rest)
    recipe(options[1], ROW_HIGHLIGHT.selected)
    expect(options.filter((row) => row.classList.contains('bg-selected-fill'))).toHaveLength(1)
    expect(options[0].getAttribute('aria-selected')).toBe('true')
  })

  it('keeps specimen menus in document flow and workspace row type size consistent', () => {
    render(<RowStateSpecimen />)
    const selected = screen.getByText('Selected workspace')
    const rest = screen.getByText('Rest workspace')
    expect(rest.className).toContain('[font-size:var(--tr-text-ui-size)]')
    expect(selected.className).toContain('[font-size:var(--tr-text-ui-size)]')
    expect(screen.getByRole('menu').style.position).toBe('static')
  })

  it('keeps editing workspace selection achromatic even when a workspace colour is supplied', () => {
    render(<WorkspaceTreeRow kind="editing" selectionColor="red">Rename workspace</WorkspaceTreeRow>)
    recipe(screen.getByText('Rename workspace'), ROW_STATE.selected)
    expect(screen.getByText('Rename workspace').style.background).toBe('')
  })
})
