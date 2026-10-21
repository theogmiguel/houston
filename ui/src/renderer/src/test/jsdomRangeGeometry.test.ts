// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

let view: EditorView | null = null

afterEach(() => {
  view?.destroy()
  view = null
})

it('an editor measures text positions under jsdom without a Range geometry TypeError', () => {
  const parent = document.createElement('div')
  document.body.append(parent)
  view = new EditorView({ state: EditorState.create({ doc: 'hello' }), parent })
  expect(() => view?.coordsAtPos(1)).not.toThrow()
  expect(document.createRange().getBoundingClientRect()).toMatchObject({ width: 0, height: 0 })
})
