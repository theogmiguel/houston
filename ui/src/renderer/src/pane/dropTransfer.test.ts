import { describe, expect, it } from 'vitest'
import {
  checkImageSizeCap,
  dragCarriesFiles,
  MAX_IMAGE_SAVE_BYTES,
  parseUriList,
  readDropEntries,
  FILE_PATH_MIME,
  URI_LIST_MIME,
  type DataTransferLike
} from './dropTransfer'

function transfer(opts: {
  types?: string[]
  data?: Record<string, string>
  files?: File[]
  items?: Array<{ kind: string; type: string; file: File | null }>
}): DataTransferLike {
  const data = opts.data ?? {}
  return {
    types: opts.types ?? Object.keys(data).concat(opts.files?.length ? ['Files'] : []),
    files: opts.files ?? [],
    items: (opts.items ?? []).map((i) => ({
      kind: i.kind,
      type: i.type,
      getAsFile: () => i.file
    })),
    getData: (type: string) => data[type] ?? ''
  }
}

function file(name: string, type = 'text/plain', size = 3): File {
  const f = new File(['abc'.slice(0, size)], name, { type })
  return f
}

describe('parseUriList', () => {
  it('decodes file:// URIs to paths', () => {
    expect(parseUriList('file:///home/dev/a.png')).toEqual(['/home/dev/a.png'])
  })

  it('percent-decodes spaces and non-ASCII names', () => {
    expect(parseUriList('file:///tmp/my%20photo.png')).toEqual(['/tmp/my photo.png'])
    expect(parseUriList('file:///tmp/%E6%97%A5%E6%9C%AC.png')).toEqual(['/tmp/日本.png'])
  })

  it('skips RFC 2483 comment lines and blank lines', () => {
    expect(parseUriList('# comment\n\nfile:///tmp/a\n')).toEqual(['/tmp/a'])
  })

  it('takes every URI of a multi-file drag, in order', () => {
    expect(parseUriList('file:///tmp/a\r\nfile:///tmp/b\r\n')).toEqual(['/tmp/a', '/tmp/b'])
  })

  it('drops non-file schemes — an http drag has no path to paste', () => {
    expect(parseUriList('https://example.com/a.png')).toEqual([])
  })

  it('drops unparseable lines rather than guessing they are paths', () => {
    expect(parseUriList('/tmp/bare-path')).toEqual([])
  })

  it('strips the leading slash of a Windows file:///C:/ path', () => {
    expect(parseUriList('file:///C:/Users/t/a.png')).toEqual(['C:/Users/t/a.png'])
  })

  it('is empty for empty input', () => {
    expect(parseUriList('')).toEqual([])
  })
})

describe('dragCarriesFiles', () => {
  it('accepts a uri-list-only drag (the WebKitGTK shape)', () => {
    expect(dragCarriesFiles(transfer({ types: [URI_LIST_MIME] }))).toBe(true)
  })

  it("accepts Chromium's 'Files' shape", () => {
    expect(dragCarriesFiles(transfer({ types: ['Files'] }))).toBe(true)
  })

  it("accepts Houston's own file tree drag (application/x-file-path)", () => {
    expect(dragCarriesFiles(transfer({ types: [FILE_PATH_MIME] }))).toBe(true)
  })

  it('accepts a drag whose only signal is an item of kind file', () => {
    const dt = transfer({ types: [], items: [{ kind: 'file', type: 'image/png', file: null }] })
    expect(dragCarriesFiles(dt)).toBe(true)
  })

  it('rejects a plain text drag — pane rearrange must not be claimed', () => {
    const dt = transfer({ types: ['text/plain'], items: [{ kind: 'string', type: 'text/plain', file: null }] })
    expect(dragCarriesFiles(dt)).toBe(false)
  })

  it('rejects a null dataTransfer', () => {
    expect(dragCarriesFiles(null)).toBe(false)
  })

  it('accepts on types alone while getData is blocked', () => {
    const dt = transfer({ types: [URI_LIST_MIME], data: {} })
    expect(dt.getData(URI_LIST_MIME)).toBe('')
    expect(dragCarriesFiles(dt)).toBe(true)
  })
})

describe('readDropEntries', () => {
  it('reads a uri-list drop as paths needing no copy', () => {
    const dt = transfer({ data: { [URI_LIST_MIME]: 'file:///tmp/a.png\nfile:///tmp/b.png' } })
    expect(readDropEntries(dt)).toEqual([{ path: '/tmp/a.png' }, { path: '/tmp/b.png' }])
  })

  it('reads application/x-file-path lines as paths', () => {
    const dt = transfer({ data: { [FILE_PATH_MIME]: '/tmp/a\n/tmp/b\n' } })
    expect(readDropEntries(dt)).toEqual([{ path: '/tmp/a' }, { path: '/tmp/b' }])
  })

  it('carries a pathless File out for the caller to copy', () => {
    const f = file('shot.png', 'image/png')
    const entries = readDropEntries(transfer({ files: [f] }))
    expect(entries).toEqual([{ file: f }])
  })

  it('does not fall through to uri-list when files already carried the drop', () => {
    const f = file('a.png', 'image/png')
    const dt = transfer({
      types: ['Files', URI_LIST_MIME],
      data: { [URI_LIST_MIME]: 'file:///real/a.png' },
      files: [f]
    })
    expect(readDropEntries(dt)).toEqual([{ file: f }])
  })

  it('reaches the uri-list path when files and items are both empty', () => {
    const dt = transfer({
      types: ['Files', URI_LIST_MIME],
      data: { [URI_LIST_MIME]: 'file:///real/a.png' },
      files: []
    })
    expect(readDropEntries(dt)).toEqual([{ path: '/real/a.png' }])
  })

  it('dedups a path advertised by both x-file-path and uri-list', () => {
    const dt = transfer({
      data: { [FILE_PATH_MIME]: '/tmp/a', [URI_LIST_MIME]: 'file:///tmp/a' }
    })
    expect(readDropEntries(dt)).toEqual([{ path: '/tmp/a' }])
  })

  it('falls back to items when files is empty', () => {
    const f = file('a.png', 'image/png')
    const dt = transfer({ types: ['Files'], items: [{ kind: 'file', type: 'image/png', file: f }] })
    expect(readDropEntries(dt)).toEqual([{ file: f }])
  })

  it('ignores items of kind string', () => {
    const dt = transfer({ types: ['text/plain'], items: [{ kind: 'string', type: 'text/plain', file: null }] })
    expect(readDropEntries(dt)).toEqual([])
  })

  it('dedups two identical File objects from files and items', () => {
    const f = file('a.png', 'image/png')
    const dt = transfer({ types: ['Files'], files: [f], items: [{ kind: 'file', type: 'image/png', file: f }] })
    expect(readDropEntries(dt)).toEqual([{ file: f }])
  })

  it('is empty for a drop carrying nothing', () => {
    expect(readDropEntries(transfer({ types: [] }))).toEqual([])
    expect(readDropEntries(null)).toEqual([])
  })
})

describe('checkImageSizeCap', () => {
  it('allows an image at the cap', () => {
    expect(checkImageSizeCap(MAX_IMAGE_SAVE_BYTES)).toBeNull()
  })

  it('allows an image under the cap', () => {
    expect(checkImageSizeCap(MAX_IMAGE_SAVE_BYTES - 1)).toBeNull()
  })

  it('refuses an image over the cap, naming the actual size and the limit', () => {
    const oversized = MAX_IMAGE_SAVE_BYTES + 1024 * 1024
    const message = checkImageSizeCap(oversized)
    expect(message).not.toBeNull()
    expect(message).toContain('51.0 MiB')
    expect(message).toContain('50.0 MiB')
  })
})
