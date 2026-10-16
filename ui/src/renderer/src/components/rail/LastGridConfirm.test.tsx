// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useGridCloseConfirm } from './LastGridConfirm'

function Harness({ childCount, onRemove }: { childCount?: number; onRemove: () => void }): React.JSX.Element {
  const { removeGrid, closingLastEl } = useGridCloseConfirm(
    { '/ws': [{ id: 'g1', name: 'Review', sessionIds: [1, 2], childCount }, { id: 'g2', name: 'Other' }] },
    onRemove,
  )
  return (
    <div>
      <button onClick={() => removeGrid?.('/ws', 'g1')}>close</button>
      {closingLastEl}
    </div>
  )
}

describe('useGridCloseConfirm neighbour', () => {
  afterEach(cleanup)

  it('hands the neighbour to the removal once the confirmation is accepted', () => {
    const onRemove = vi.fn()
    function Close(): React.JSX.Element {
      const { removeGrid, closingLastEl } = useGridCloseConfirm({ '/ws': [{ id: 'g1', name: 'Review', sessionIds: [1] }, { id: 'g2', name: 'Other' }] }, onRemove)
      return <div><button onClick={() => removeGrid?.('/ws', 'g1', 'g2')}>close</button>{closingLastEl}</div>
    }
    render(<Close />)
    fireEvent.click(screen.getByText('close'))
    fireEvent.click([...document.querySelectorAll('button')].find((button) => button.textContent === 'Close grid')!)
    expect(onRemove).toHaveBeenCalledWith('/ws', 'g1', 'g2')
  })
})

describe('useGridCloseConfirm', () => {
  afterEach(cleanup)

  it('names the child agents the close also ends', () => {
    render(<Harness childCount={3} onRemove={vi.fn()} />)
    fireEvent.click(screen.getByText('close'))
    expect(document.body.textContent).toContain('ends its 2 agents and their 3 child agents.')
  })

  it('mentions no children when the grid has none', () => {
    render(<Harness onRemove={vi.fn()} />)
    fireEvent.click(screen.getByText('close'))
    expect(document.body.textContent).toContain('ends its 2 agents.')
    expect(document.body.textContent).not.toContain('child')
  })
})
