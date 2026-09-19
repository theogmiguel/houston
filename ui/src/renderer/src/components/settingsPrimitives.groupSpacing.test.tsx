// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Group, Row, SectionHead } from './settingsPrimitives'

describe('settings groups keep their rhythm', () => {
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

  it('a group after another group carries the 24px rung; the first carries none', () => {
    act(() => {
      root.render(
        <>
          <SectionHead title="Appearance" lede="Two axes." />
          <Group heading="Chrome theme" plain>
            <div />
          </Group>
          <Group heading="Terminal palette">
            <Row title="Palette" variant="list" />
          </Group>
        </>
      )
    })
    const groups = container.querySelectorAll<HTMLElement>('[data-testid="settings-group"]')
    expect(groups).toHaveLength(2)
    for (const g of groups) expect(g.className).toContain('[&+&]:pt-[var(--space-5)]')
    for (const h of container.querySelectorAll('[data-testid="settings-subhead"]')) {
      expect(h.className).toContain('[&:first-of-type]:pt-0')
    }
  })
})
