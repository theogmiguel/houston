// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RoutinesSurface } from './nav/RoutinesSurface'

const FILL = ['flex-1', 'min-w-0']

describe('full-surface overlays fill the flex-row slot App gives them', () => {
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

  const expectFills = (sel: string): void => {
    const el = container.querySelector<HTMLElement>(sel)
    expect(el, `${sel} did not render`).not.toBeNull()
    for (const cls of FILL) {
      expect(el!.classList.contains(cls), `${sel} is missing \`${cls}\``).toBe(true)
    }
  }

  it('RoutinesSurface (the rail nav-surface shape NavSurface used to own)', () => {
    act(() =>
      root.render(
        <RoutinesSurface
          routines={[]}
          running={[]}
          runs={{}}
          runsLoading={null}
          workspaces={[]}
          error={null}
          onDismissError={() => {}}
          onCreate={() => {}}
          onUpdate={() => {}}
          onDelete={() => {}}
          onRunNow={() => {}}
          onLoadRuns={() => {}}
          onOpenSession={() => {}}
          onRequest={() => {}}
          now={0}
        />
      )
    )
    expectFills('[data-testid="nav-surface"]')
  })
})
