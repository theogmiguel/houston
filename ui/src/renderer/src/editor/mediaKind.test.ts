import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  classifyMediaKind,
  extOf,
  isPreviewBlocked,
  MEDIA_EXTS,
  mimeForPath,
  type MediaKind
} from './mediaKind'

describe('classifyMediaKind', () => {
  it('classifies raster image extensions', () => {
    expect(classifyMediaKind('/ws/photo.png')).toBe('image')
    expect(classifyMediaKind('/ws/photo.jpg')).toBe('image')
    expect(classifyMediaKind('/ws/photo.webp')).toBe('image')
  })

  it('classifies svg as text, not image -- it is text-decodable, unlike every other image extension', () => {
    expect(classifyMediaKind('/ws/icon.svg')).toBe('text')
  })

  it('classifies video extensions', () => {
    expect(classifyMediaKind('/ws/clip.mp4')).toBe('video')
    expect(classifyMediaKind('/ws/clip.webm')).toBe('video')
  })

  it('classifies audio extensions', () => {
    expect(classifyMediaKind('/ws/track.mp3')).toBe('audio')
    expect(classifyMediaKind('/ws/track.wav')).toBe('audio')
  })

  it('classifies known-binary extensions as unsupported', () => {
    expect(classifyMediaKind('/ws/lib.so')).toBe('unsupported')
    expect(classifyMediaKind('/ws/app.exe')).toBe('unsupported')
    expect(classifyMediaKind('/ws/module.wasm')).toBe('unsupported')
  })

  it('sends conventionally-but-not-certainly binary extensions down the ordinary read path', () => {
    expect(classifyMediaKind('/ws/data.dat')).toBe('text')
    expect(classifyMediaKind('/ws/blob.bin')).toBe('text')
  })

  it('defaults to text for an unknown or missing extension -- the unchanged case', () => {
    expect(classifyMediaKind('/ws/main.rs')).toBe('text')
    expect(classifyMediaKind('/ws/README')).toBe('text')
    expect(classifyMediaKind('/ws/Makefile')).toBe('text')
  })

  it('is case-insensitive on the extension', () => {
    expect(classifyMediaKind('/ws/PHOTO.PNG')).toBe('image')
  })

  it('classifies markdown extensions', () => {
    expect(classifyMediaKind('/ws/README.md')).toBe('markdown')
    expect(classifyMediaKind('/ws/notes.markdown')).toBe('markdown')
    expect(classifyMediaKind('/ws/README.MD')).toBe('markdown')
  })

  it('leaves .mdx on the plain text path', () => {
    expect(classifyMediaKind('/ws/page.mdx')).toBe('text')
  })
})

describe('isPreviewBlocked', () => {
  it('blocks only unsupported', () => {
    expect(isPreviewBlocked('unsupported')).toBe(true)
  })

  it('does not block image/video/audio, text or markdown', () => {
    expect(isPreviewBlocked('image')).toBe(false)
    expect(isPreviewBlocked('video')).toBe(false)
    expect(isPreviewBlocked('audio')).toBe(false)
    expect(isPreviewBlocked('text')).toBe(false)
    expect(isPreviewBlocked('markdown')).toBe(false)
  })

  it('names every kind exactly once, so a new kind has to be decided about', () => {
    const kinds: Record<MediaKind, boolean> = {
      image: false,
      video: false,
      audio: false,
      text: false,
      markdown: false,
      unsupported: true
    }
    for (const [kind, blocked] of Object.entries(kinds)) {
      expect(isPreviewBlocked(kind as MediaKind), kind).toBe(blocked)
    }
  })
})

describe('the extension lists that must agree', () => {
  it('every media extension has a MIME type -- adding one to a set without a MIME fails here', () => {
    const missing = [...MEDIA_EXTS].filter(
      (ext) => mimeForPath(`/ws/f.${ext}`) === 'application/octet-stream'
    )
    expect(missing, 'media extensions with no MIME_BY_EXT entry').toEqual([])
  })

  it("matches Rust's MEDIA_EXTS in src-tauri/src/fs.rs, in both directions", () => {
    const fsRs = fileURLToPath(new URL('../../../../../src-tauri/src/fs.rs', import.meta.url))
    const source = readFileSync(fsRs, 'utf8')
    const literal = /const MEDIA_EXTS: &\[&str\] = &\[([^\]]*)\];/.exec(source)
    expect(literal, `could not find "const MEDIA_EXTS: &[&str] = &[...]" in ${fsRs}`).not.toBeNull()
    const rustExts = new Set(
      [...(literal?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1])
    )
    expect(rustExts.size, 'the Rust literal parsed as empty').toBeGreaterThan(0)

    const ts = [...MEDIA_EXTS].sort()
    expect([...rustExts].sort(), 'Rust MEDIA_EXTS vs TS MEDIA_EXTS').toEqual(ts)
  })

  it('keeps markdown out of MEDIA_EXTS -- it takes the text path, not the byte transport', () => {
    expect([...MEDIA_EXTS]).not.toContain('md')
    expect([...MEDIA_EXTS]).not.toContain('markdown')
    expect([...MEDIA_EXTS].map((ext) => classifyMediaKind(`/ws/f.${ext}`))).not.toContain('markdown')
  })

  it('extOf answers the same question Rust ext_of answers, dotfiles included', () => {
    expect(extOf('/ws/photo.PNG')).toBe('png')
    expect(extOf('/ws/.env')).toBe('env')
    expect(extOf('/ws/.png')).toBe('png')
    expect(extOf('/ws/archive.tar.gz')).toBe('gz')
    expect(extOf('/ws/Makefile')).toBe('')
    expect(extOf('/ws.d/Makefile')).toBe('')
  })
})
