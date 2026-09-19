import { describe, expect, it } from 'vitest'
import { decideCompositionInput, isTerminalCompositionCommitInput } from './surface'

class ImeReplay {
  value = ''
  composing = false
  suppressed: string | null = null
  readonly delivered: string[] = []

  compositionStart(): void {
    this.suppressed = null
    this.composing = true
  }

  compositionEnd(data: string): void {
    this.composing = false
    const payload = this.value || data
    if (payload.length > 0) this.delivered.push(payload)
    this.value = ''
    this.suppressed = payload
  }

  input(data: string, inputType: string, isComposing = false): void {
    if (this.composing || isComposing) return
    const payload = this.value || data
    const verdict = decideCompositionInput(this.suppressed, payload, { inputType })
    this.suppressed = null
    if (verdict.deliver) this.delivered.push(payload)
    this.value = ''
  }

  type(text: string): void {
    this.value += text
  }
}

describe('decideCompositionInput', () => {
  it('drops the browser’s own commit echo of the text just delivered', () => {
    for (const inputType of ['', 'insertCompositionText', 'insertFromComposition']) {
      expect(decideCompositionInput('ç', 'ç', { inputType }).deliver).toBe(false)
      expect(isTerminalCompositionCommitInput({ inputType })).toBe(true)
    }
  })

  it('delivers genuinely typed text, even the same character again', () => {
    expect(decideCompositionInput('ç', 'ç', { inputType: 'insertText' }).deliver).toBe(true)
    expect(decideCompositionInput(null, 'ç', { inputType: 'insertCompositionText' }).deliver).toBe(
      true
    )
    expect(decideCompositionInput('ç', 'a', { inputType: 'insertCompositionText' }).deliver).toBe(
      true
    )
  })

  it('never delivers an empty payload and always spends the suppression', () => {
    const verdict = decideCompositionInput('ç', '', { inputType: 'insertCompositionText' })
    expect(verdict.deliver).toBe(false)
    expect(verdict.clearSuppression).toBe(true)
  })
})

describe('D3 repro: the ç dead-key sequence', () => {
  it('delivers exactly one ç for a well-formed composition', () => {
    const ime = new ImeReplay()
    ime.compositionStart()
    ime.type('ç')
    ime.compositionEnd('ç')
    ime.input('ç', 'insertCompositionText')
    expect(ime.delivered).toEqual(['ç'])
    expect(ime.value).toBe('')
  })

  it('delivers exactly one ç when compositionstart never fires — the xterm bug’s own shape', () => {
    const ime = new ImeReplay()
    ime.type('ç')
    ime.compositionEnd('ç')
    ime.input('ç', '')
    expect(ime.delivered).toEqual(['ç'])
  })

  it('does not accumulate across a burst of dead-key compositions', () => {
    const ime = new ImeReplay()
    for (let i = 0; i < 6; i += 1) {
      ime.type('ç')
      ime.compositionEnd('ç')
      ime.input('ç', 'insertCompositionText')
    }
    expect(ime.delivered).toEqual(['ç', 'ç', 'ç', 'ç', 'ç', 'ç'])
    expect(ime.value).toBe('')
  })

  it('ignores input events fired while a composition is still open', () => {
    const ime = new ImeReplay()
    ime.compositionStart()
    ime.input('ﾆ', 'insertCompositionText')
    ime.input('ニ', 'insertCompositionText')
    expect(ime.delivered).toEqual([])
    ime.compositionEnd('ニ')
    expect(ime.delivered).toEqual(['ニ'])
  })

  it('keeps ordinary typing after a composition intact', () => {
    const ime = new ImeReplay()
    ime.compositionStart()
    ime.type('ç')
    ime.compositionEnd('ç')
    ime.input('ç', 'insertCompositionText')
    ime.input('a', 'insertText')
    ime.input('o', 'insertText')
    expect(ime.delivered).toEqual(['ç', 'a', 'o'])
  })
})
