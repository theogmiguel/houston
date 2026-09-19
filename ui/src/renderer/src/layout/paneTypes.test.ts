import { describe, expect, it } from 'vitest'
import { PANE_TYPES, paneTypeButtonState } from './paneTypes'

describe('pane-type registry (step 04)', () => {
  it('covers exactly the four grid pane kinds, with no Changes row', () => {
    expect(PANE_TYPES.map((t) => t.kind).sort()).toEqual([
      'browser',
      'editor',
      'files',
      'skills'
    ])
  })

  it('puts `files` FIRST, which is what puts it under Terminal in the + menu', () => {
    expect(PANE_TYPES[0].kind).toBe('files')
    const files = PANE_TYPES.find((t) => t.kind === 'files')!
    expect(files.label).toBe('Files')
    expect(files.insertable).toBe(true)
    expect(files.needsWorkspace).toBe(true)
  })

  it('editor and skills are excluded from the insertable set', () => {
    const editor = PANE_TYPES.find((t) => t.kind === 'editor')!
    expect(editor.insertable).toBe(false)
    expect(PANE_TYPES.filter((t) => t.insertable).map((t) => t.kind).sort()).toEqual([
      'browser',
      'files'
    ])
  })

  it('disables a workspace-scoped type with no workspace open, and names why', () => {
    const files = PANE_TYPES.find((t) => t.kind === 'files')!
    expect(paneTypeButtonState(files, false)).toEqual({
      disabled: true,
      title: 'Open a workspace to use Files'
    })
    expect(paneTypeButtonState(files, true)).toEqual({ disabled: false, title: files.hint })
  })

  it('never disables a type with no workspace requirement', () => {
    const browser = PANE_TYPES.find((t) => t.kind === 'browser')!
    expect(paneTypeButtonState(browser, false)).toEqual({ disabled: false, title: browser.hint })
  })
})
