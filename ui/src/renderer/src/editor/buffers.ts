// Pulls in the whole CodeMirror stack and must only ever be reached through a
// dynamic `import()`, never a static one, or the split from `bufferStore.ts`
// buys nothing.
import { basicSetup } from 'codemirror'
import { EditorView as CmView, keymap } from '@codemirror/view'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { indentWithTab } from '@codemirror/commands'
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { tags } from '@lezer/highlight'
import { readFile, statFile, writeFile } from '../houston/bridge'
import {
  basename,
  bufferKey,
  detectLineEnding,
  notify,
  noteUpdate,
  store,
  type EditorBuffer
} from './bufferStore'

export {
  basename,
  cleanError,
  closeBuffer,
  detectLineEnding,
  dirtyBufferPaths,
  dropWorkspaceBuffers,
  getBuffer,
  onReveal,
  requestReveal,
  retainBuffer,
  subscribeBuffer,
  takePendingReveal,
  type EditorBuffer,
  type LineEnding,
  type RevealRequest
} from './bufferStore'

export const cmTheme = CmView.theme({
  '&': {
    height: '100%',
    fontSize: '12px',
    backgroundColor: 'transparent',
    color: 'var(--text-primary)'
  },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-gutters': {
    color: 'var(--text-faint)',
    border: 'none'
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 7%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-muted)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground':
    {
      backgroundColor: 'color-mix(in srgb, var(--accent) 28%, transparent)'
    },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--accent) 16%, transparent)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--warning) 28%, transparent)' },
  '.cm-panels': { backgroundColor: 'var(--card-bg)', color: 'var(--text-primary)' },
  '.cm-tooltip': { background: 'var(--card-bg)', border: '1px solid var(--border)' }
})

export const cmHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], color: 'var(--hljs-keyword)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--hljs-string)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--hljs-number)' },
  { tag: tags.comment, color: 'var(--hljs-comment)', fontStyle: 'italic' },
  {
    tag: [
      tags.function(tags.variableName),
      tags.function(tags.propertyName),
      tags.typeName,
      tags.className
    ],
    color: 'var(--hljs-title)'
  },
  { tag: [tags.attributeName, tags.propertyName], color: 'var(--hljs-attr)' },
  { tag: tags.tagName, color: 'var(--hljs-tag)' },
  { tag: tags.heading, color: 'var(--hljs-title)', fontWeight: '700' },
  { tag: [tags.link, tags.url], color: 'var(--hljs-string)' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '700' }
])

const langCompartment = new Compartment()
const wrapCompartment = new Compartment()

const PROSE_EXT = new Set(['md', 'markdown', 'mdx', 'txt', 'text', 'rst'])
function defaultWrapFor(path: string): boolean {
  return PROSE_EXT.has(basename(path).split('.').pop()?.toLowerCase() ?? '')
}

function loadLanguage(workspaceDir: string, path: string): void {
  const desc = LanguageDescription.matchFilename(languages, basename(path))
  if (!desc) return
  void desc.load().then((support) => {
    const key = bufferKey(workspaceDir, path)
    const e = store.get(key)
    if (!e) return
    e.buf = {
      ...e.buf,
      state: e.buf.state.update({ effects: langCompartment.reconfigure(support) }).state
    }
    notify(key)
  })
}

function bufferExtensions(
  workspaceDir: string,
  path: string,
  onSave: () => void,
  wrap: boolean
): Extension[] {
  return [
    basicSetup,
    keymap.of([
      {
        key: 'Mod-s',
        run: () => {
          onSave()
          return true
        }
      },
      indentWithTab
    ]),
    cmTheme,
    syntaxHighlighting(cmHighlight),
    langCompartment.of([]),
    wrapCompartment.of(wrap ? CmView.lineWrapping : []),
    CmView.updateListener.of((u) => noteUpdate(workspaceDir, path, u.state, u.docChanged))
  ]
}

const loading = new Map<string, Promise<EditorBuffer>>()

export async function ensureBuffer(
  workspaceDir: string,
  path: string,
  onSave: () => void
): Promise<EditorBuffer> {
  const key = bufferKey(workspaceDir, path)
  const existing = store.get(key)
  if (existing) return existing.buf
  const already = loading.get(key)
  if (already) return already
  const p = (async (): Promise<EditorBuffer> => {
    const [content, stat] = await Promise.all([
      readFile(path),
      statFile(path)
    ])
    const wrap = defaultWrapFor(path)
    const extensions = bufferExtensions(workspaceDir, path, onSave, wrap)
    const buf: EditorBuffer = {
      state: EditorState.create({ doc: content, extensions }),
      dirty: false,
      mtimeMs: stat?.mtimeMs ?? null,
      conflict: false,
      wrap,
      lineEnding: detectLineEnding(content)
    }
    store.set(key, { buf, extensions })
    loadLanguage(workspaceDir, path)
    return buf
  })()
  loading.set(key, p)
  try {
    return await p
  } finally {
    loading.delete(key)
  }
}

export async function saveBuffer(workspaceDir: string, path: string): Promise<'saved' | 'conflict'> {
  const key = bufferKey(workspaceDir, path)
  const e = store.get(key)
  if (!e) throw new Error(`saveBuffer: no buffer loaded for ${path}`)
  const disk = await statFile(path)
  if (e.buf.mtimeMs !== null && disk !== null && disk.mtimeMs !== e.buf.mtimeMs) {
    e.buf = { ...e.buf, conflict: true }
    notify(key)
    return 'conflict'
  }
  await writeFile(path, e.buf.state.doc.toString())
  const after = await statFile(path)
  e.buf = { ...e.buf, dirty: false, conflict: false, mtimeMs: after?.mtimeMs ?? null, lineEnding: 'LF' }
  notify(key)
  return 'saved'
}

export async function overwriteBuffer(workspaceDir: string, path: string): Promise<void> {
  const key = bufferKey(workspaceDir, path)
  const e = store.get(key)
  if (!e) throw new Error(`overwriteBuffer: no buffer loaded for ${path}`)
  await writeFile(path, e.buf.state.doc.toString())
  const after = await statFile(path)
  e.buf = { ...e.buf, dirty: false, conflict: false, mtimeMs: after?.mtimeMs ?? null, lineEnding: 'LF' }
  notify(key)
}

export async function reloadBuffer(workspaceDir: string, path: string): Promise<void> {
  const key = bufferKey(workspaceDir, path)
  const e = store.get(key)
  if (!e) throw new Error(`reloadBuffer: no buffer loaded for ${path}`)
  const [content, stat] = await Promise.all([
    readFile(path),
    statFile(path)
  ])
  const wrap = e.buf.wrap
  const fresh = EditorState.create({ doc: content, extensions: e.extensions })
  e.buf = {
    state: fresh.update({
      effects: wrapCompartment.reconfigure(wrap ? CmView.lineWrapping : [])
    }).state,
    dirty: false,
    conflict: false,
    mtimeMs: stat?.mtimeMs ?? null,
    wrap,
    lineEnding: detectLineEnding(content)
  }
  notify(key)
  loadLanguage(workspaceDir, path)
}

export function setBufferWrap(workspaceDir: string, path: string, wrap: boolean): void {
  const key = bufferKey(workspaceDir, path)
  const e = store.get(key)
  if (!e) return
  e.buf = {
    ...e.buf,
    wrap,
    state: e.buf.state.update({
      effects: wrapCompartment.reconfigure(wrap ? CmView.lineWrapping : [])
    }).state
  }
  notify(key)
}
