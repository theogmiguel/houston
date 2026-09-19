import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const FILES = [
  join(__dirname, '../ChangesPane.tsx'),
  join(__dirname, 'changes.ts'),
  join(__dirname, 'DiffBody.tsx'),
  join(__dirname, 'scmChrome.ts'),
  join(__dirname, 'ScmNotice.tsx')
]

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^[^\S\n]*\/\/.*$/gm, '')
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length
}

function findAll(text: string, re: RegExp): { match: string; line: number }[] {
  const out: { match: string; line: number }[] = []
  for (const m of text.matchAll(re)) out.push({ match: m[0], line: lineOf(text, m.index ?? 0) })
  return out
}

describe('Changes pane — no raw literal a token already covers', () => {
  it('no raw hex colour literal (§10 colour from theme tokens)', () => {
    const offenders: string[] = []
    for (const file of FILES) {
      const text = stripComments(readFileSync(file, 'utf8'))
      for (const { match, line } of findAll(text, /#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])/g)) {
        offenders.push(`${file.split('/components/')[1]}:${line} ${match}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('no bare `text-[Npx]` — every size reads a --tr-text-* token (§09)', () => {
    const offenders: string[] = []
    for (const file of FILES) {
      const text = stripComments(readFileSync(file, 'utf8'))
      for (const { match, line } of findAll(text, /text-\[[0-9.]+px\]/g)) {
        offenders.push(`${file.split('/components/')[1]}:${line} ${match}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('no un-tokenised radius utility — every radius reads a --tr-radius-* token (§10)', () => {
    const offenders: string[] = []
    const RAW_RADIUS = /rounded-(full|sm|md|lg|xl|2xl|3xl|none|\[[0-9]+px\])(?![\w-])/g
    for (const file of FILES) {
      const text = stripComments(readFileSync(file, 'utf8'))
      for (const { match, line } of findAll(text, RAW_RADIUS)) {
        offenders.push(`${file.split('/components/')[1]}:${line} ${match}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('every `rounded-[var(--tr-radius-*)]` names one of the five real radius tokens', () => {
    const REAL = new Set([
      'sm',
      'md',
      'input',
      'button',
      'card',
      'panel',
      'pill'
    ])
    const offenders: string[] = []
    for (const file of FILES) {
      const text = stripComments(readFileSync(file, 'utf8'))
      for (const { match, line } of findAll(text, /rounded-\[var\(--tr-radius-([a-z]+)\)\]/g)) {
        const name = /--tr-radius-([a-z]+)/.exec(match)![1]
        if (!REAL.has(name)) offenders.push(`${file.split('/components/')[1]}:${line} ${match}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
