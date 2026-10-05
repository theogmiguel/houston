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

  it('names the workspace scope for the page and for each scoped row', () => {
    act(() => root.render(<><SettingsScope workspace="Houston" /><SettingsScope workspace="Houston" row /></>))
    expect(host.textContent).toContain('Applying settings for Houston')
    expect(host.textContent).toContain('This workspace')
  })

  it('explains why workspace rows cannot be edited without a workspace', () => {
    act(() => root.render(<><SettingsScope workspace={null} /><SettingsScope workspace={null} row /></>))
    expect(host.textContent).toContain('Select a workspace')
    expect(host.textContent).toContain('Choose a workspace to edit this setting.')
  })
})
