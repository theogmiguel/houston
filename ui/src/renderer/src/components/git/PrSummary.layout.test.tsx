// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { PrDetail } from '../../houston/client'
import { PrBranchSummary } from './PrSummary'

const detail = { body: '# Problem\n\n' + 'A long description. '.repeat(100) } as PrDetail
afterEach(cleanup)

describe('panel description', () => {
  it('renders panel Markdown and expands the clamped description on request', () => {
    const view = render(<PrBranchSummary detail={detail} people={null} checks={null} footer={null} descriptionAction={null} />)
    expect(screen.queryByTestId('panel-markdown-body')).not.toBeNull()
    for (const level of [1, 2, 3, 4, 5, 6]) expect(screen.getByTestId('panel-markdown-body').className).toContain(`[&_h${level}]:text-[length:var(--tr-text-ui-size)]`)
    expect(screen.getByTestId('pr-description').getAttribute('data-clamped')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Show full description' }))
    expect(screen.getByTestId('pr-description').getAttribute('data-clamped')).toBe('false')
    expect(screen.getByRole('heading', { name: 'Problem' }).tagName).toBe('H1')
    view.unmount()
  })
})
