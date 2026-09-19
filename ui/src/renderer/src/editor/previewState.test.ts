import { describe, expect, it } from 'vitest'
import { classifyReadError, formatMB, formatMBWhole } from './previewState'

describe('classifyReadError', () => {
  it('parses the too-large-to-edit refusal, pulling the real size and cap out of the message', () => {
    const msg = 'file too large to edit: /ws/big.bin is 3000000 bytes (max 2097152)'
    expect(classifyReadError(msg)).toEqual({
      kind: 'too-large',
      sizeBytes: 3000000,
      maxBytes: 2097152,
      title: 'File too large to edit'
    })
  })

  it('parses the too-large-to-preview refusal (fs_read_media), with its own title', () => {
    const msg = 'file too large to preview: /ws/clip.mp4 is 70000000 bytes (max 67108864)'
    expect(classifyReadError(msg)).toEqual({
      kind: 'too-large',
      sizeBytes: 70000000,
      maxBytes: 67108864,
      title: 'File too large to preview'
    })
  })

  it('maps the NUL-byte binary refusal to the unsupported state', () => {
    const msg = 'refusing to open binary file: /ws/photo.png'
    expect(classifyReadError(msg)).toEqual({ kind: 'unsupported' })
  })

  it('maps the UTF-8 decode refusal to an "Unsupported encoding" error, keeping the detail', () => {
    const msg = 'file /ws/weird.dat is not valid UTF-8 text: invalid utf-8 sequence of 1 bytes from index 4'
    expect(classifyReadError(msg)).toEqual({
      kind: 'error',
      title: 'Unsupported encoding',
      detail: msg
    })
  })

  it('falls back to "Could not read file" for anything else (IO errors, allowlist rejections, ...)', () => {
    const msg = 'cannot read file /ws/x.txt: Permission denied (os error 13)'
    expect(classifyReadError(msg)).toEqual({
      kind: 'error',
      title: 'Could not read file',
      detail: msg
    })
  })

  it('does not match the too-large shape on a message that merely mentions "bytes"', () => {
    const msg = 'cannot read file /ws/x.txt: read 12 bytes then failed'
    expect(classifyReadError(msg).kind).toBe('error')
  })

  describe('the two too-large patterns each match only their own command', () => {
    const EDIT_MSG = 'file too large to edit: /ws/big.bin is 3000000 bytes (max 2097152)'
    const PREVIEW_MSG = 'file too large to preview: /ws/clip.mp4 is 70000000 bytes (max 16777216)'

    it('classifies each message under its own title', () => {
      const edit = classifyReadError(EDIT_MSG)
      const preview = classifyReadError(PREVIEW_MSG)
      expect(edit).toMatchObject({ kind: 'too-large', title: 'File too large to edit' })
      expect(preview).toMatchObject({ kind: 'too-large', title: 'File too large to preview' })
    })

    it('never classifies either message under the other one\'s title', () => {
      expect(classifyReadError(EDIT_MSG)).not.toMatchObject({ title: 'File too large to preview' })
      expect(classifyReadError(PREVIEW_MSG)).not.toMatchObject({ title: 'File too large to edit' })
    })

    it('rejects a hybrid message neither command emits', () => {
      const msg = 'file too large to view: /ws/x.png is 900 bytes (max 100)'
      expect(classifyReadError(msg).kind).toBe('error')
    })
  })
})

describe('formatMB', () => {
  it('formats bytes as MB with one decimal place', () => {
    expect(formatMB(2 * 1024 * 1024)).toBe('2.0 MB')
    expect(formatMB(3000000)).toBe('2.9 MB')
  })
})

describe('formatMBWhole', () => {
  it('formats bytes as a whole-number MB, no decimal', () => {
    expect(formatMBWhole(2 * 1024 * 1024)).toBe('2 MB')
    expect(formatMBWhole(3000000)).toBe('3 MB')
  })
})
