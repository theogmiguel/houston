// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsScope } from './SettingsScope'

describe('SettingsScope', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('names the scope of each scoped row', () => {
    act(() => root.render(<><SettingsScope workspace="Houston" /><SettingsScope workspace={null} scope="global" /></>))
    expect(host.textContent).toContain('This workspace')
    expect(host.textContent).toContain('All workspaces')
  })

  it('explains that a workspace row cannot be edited without a workspace', () => {
    act(() => root.render(<SettingsScope workspace={null} />))
    expect(host.textContent).toContain('Choose a workspace to edit this setting.')
  })
})
