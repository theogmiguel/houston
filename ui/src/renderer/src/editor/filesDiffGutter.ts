import { RangeSet, StateEffect, StateField } from '@codemirror/state'
import { GutterMarker, gutter, type EditorView } from '@codemirror/view'
import type { FileDiffLines } from '../components/files/fileDiffLines'

const setChanges = StateEffect.define<FileDiffLines>()

class DiffMarker extends GutterMarker {
  constructor(readonly kind: 'added' | 'modified' | 'deleted') { super() }

  toDOM(): HTMLElement {
    const marker = document.createElement('span')
    marker.className = `files-diff-marker files-diff-marker--${this.kind}`
    return marker
  }

  eq(other: GutterMarker): boolean {
    return other instanceof DiffMarker && other.kind === this.kind
  }
}

const markers: Record<DiffMarker['kind'], DiffMarker> = {
  added: new DiffMarker('added'),
  modified: new DiffMarker('modified'),
  deleted: new DiffMarker('deleted')
}

const changesField = StateField.define<FileDiffLines>({
  create: () => ({ added: new Set(), modified: new Set(), deleted: new Set() }),
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setChanges)) return effect.value
    return value
  }
})

export const filesDiffGutter = [
  changesField,
  gutter({
    class: 'files-diff-gutter',
    markers: (view) => {
      const changes = view.state.field(changesField)
      const ranges = [...changes.added, ...changes.modified, ...changes.deleted]
        .sort((a, b) => a - b)
        .map((line) => {
          const kind = changes.deleted.has(line) ? 'deleted' : changes.modified.has(line) ? 'modified' : 'added'
          return markers[kind].range(view.state.doc.line(Math.min(line, view.state.doc.lines)).from)
        })
      return RangeSet.of(ranges)
    }
  })
]

export function updateFilesDiffGutter(view: EditorView, changes: FileDiffLines): void {
  if (!view.state.field(changesField, false)) {
    view.dispatch({ effects: StateEffect.appendConfig.of(filesDiffGutter) })
  }
  view.dispatch({ effects: setChanges.of(changes) })
}
