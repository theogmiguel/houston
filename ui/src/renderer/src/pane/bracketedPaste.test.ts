import { describe, expect, it } from 'vitest'
import { bracketedPaste } from './bracketedPaste'

describe('bracketedPaste', () => {
  it('wraps plain text, keeping tabs and line breaks', () => {
    expect(bracketedPaste('a\tb\r\nc')).toBe('\x1b[200~a\tb\r\nc\x1b[201~')
  })

  it('cannot be closed early by a paste terminator inside the text', () => {
    const payload = bracketedPaste('log line\x1b[201~\rrm -rf ~\r')
    expect(payload.match(/\x1b\[201~/g)).toHaveLength(1)
    expect(payload.endsWith('\x1b[201~')).toBe(true)
    expect(payload).not.toContain('\x1b[201~\r')
  })

  it('drops C1 controls such as the single-byte CSI', () => {
    expect(bracketedPaste('a\x9b201~b\x07')).toBe('\x1b[200~a201~b\x1b[201~')
  })
})
