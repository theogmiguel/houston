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
import { readFile, statFile, writeFileChecked } from '../houston/bridge'
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
const WRAP_PREFERENCE_KEY = 'tr-files-word-wrap'

function defaultWrapFor(path: string): boolean {
  try {
    const preference = localStorage.getItem(WRAP_PREFERENCE_KEY)
    if (preference !== null) return preference === 'true'
  } catch {
    // Storage can be unavailable in embedded browser contexts.
  }
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
    const revision = contentHash(content)
    const entry = { buf, extensions, revision }
    store.set(key, entry)
    void entry.revision.then((sha256) => { if (store.get(key) === entry && entry.revision === revision) entry.buf = { ...entry.buf, sha256 } })
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
  const content = e.buf.state.doc.toString()
  try {
    const sha256 = await writeFileChecked(path, content, e.buf.sha256 ?? await e.revision!)
    e.revision = Promise.resolve(sha256)
    e.buf = { ...e.buf, sha256, dirty: e.buf.state.doc.toString() !== content, conflict: false, lineEnding: 'LF' }
  } catch (error) {
    if (!String(error).includes('FILE_SAVE_CONFLICT')) throw error
    e.buf = { ...e.buf, conflict: true }
    notify(key)
    return 'conflict'
  }
  notify(key)
  return 'saved'
}

export async function overwriteBuffer(workspaceDir: string, path: string): Promise<void> {
  const key = bufferKey(workspaceDir, path)
  const e = store.get(key)
  if (!e) throw new Error(`overwriteBuffer: no buffer loaded for ${path}`)
  const sha256 = await contentHash(await readFile(path))
  e.revision = Promise.resolve(sha256)
  e.buf = { ...e.buf, sha256 }
  await saveBuffer(workspaceDir, path)
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
  const sha256 = await contentHash(content)
  e.revision = Promise.resolve(sha256)
  const wrap = e.buf.wrap
  const fresh = EditorState.create({ doc: content, extensions: e.extensions })
  e.buf = {
    state: fresh.update({
      effects: wrapCompartment.reconfigure(wrap ? CmView.lineWrapping : [])
    }).state,
    dirty: false,
    conflict: false,
    mtimeMs: stat?.mtimeMs ?? null,
    sha256,
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
  try {
    localStorage.setItem(WRAP_PREFERENCE_KEY, String(wrap))
  } catch {
    // Storage can be unavailable in embedded browser contexts.
  }
  notify(key)
}

export async function contentHash(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function checkBufferRevision(workspaceDir: string, path: string): Promise<void> {
  const key = bufferKey(workspaceDir, path)
  const entry = store.get(key)
  if (!entry) return
  const revision = entry.revision
  const content = await readFile(path)
  const sha256 = await contentHash(content)
  if (store.get(key) !== entry || entry.revision !== revision || sha256 === entry.buf.sha256) return
  if (entry.buf.dirty) {
    entry.buf = { ...entry.buf, conflict: true }
    notify(key)
  } else {
    const fresh = EditorState.create({ doc: content, extensions: entry.extensions })
    entry.revision = Promise.resolve(sha256)
    entry.buf = {
      ...entry.buf,
      state: fresh.update({ effects: wrapCompartment.reconfigure(entry.buf.wrap ? CmView.lineWrapping : []) }).state,
      sha256,
      conflict: false,
      lineEnding: detectLineEnding(content)
    }
    notify(key)
    loadLanguage(workspaceDir, path)
  }
}
