// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DelimitedTable } from './DelimitedTable'

afterEach(cleanup)

describe('DelimitedTable', () => {
  it('renders quoted CSV cells and right-aligns numeric values', () => {
    render(<DelimitedTable source={'name,count\n"alpha, beta",12'} />)
    expect(screen.getByRole('columnheader', { name: 'name' })).toBeTruthy()
    expect(screen.getByText('alpha, beta')).toBeTruthy()
    expect(screen.getByText('12').className).toContain('text-right')
  })
})
