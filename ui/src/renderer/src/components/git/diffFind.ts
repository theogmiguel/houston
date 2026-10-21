import { createContext } from 'react'
import type { DiffTextMarks } from '../ui/Diff'

/** One searchable diff: `lines` are the texts the surface renders, in render order. */
export interface DiffFindSource {
  key: string
  lines: readonly string[]
  truncated: boolean
}

export interface DiffFindMatch {
  key: string
  line: number
  start: number
  end: number
}

// Bounds the work and the rendered marks for a one-letter query over a 512 KiB patch.
export const MAX_DIFF_FIND_MATCHES = 5000

export interface DiffFindResult {
  matches: DiffFindMatch[]
  capped: boolean
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

export function findInDiff(sources: readonly DiffFindSource[], term: string, caseSensitive: boolean): DiffFindResult {
  if (term.length === 0) return { matches: [], capped: false }
  const pattern = new RegExp(escapeRegExp(term), caseSensitive ? 'gu' : 'giu')
  const matches: DiffFindMatch[] = []
  for (const source of sources) {
    for (let line = 0; line < source.lines.length; line++) {
      pattern.lastIndex = 0
      for (let hit = pattern.exec(source.lines[line]); hit !== null; hit = pattern.exec(source.lines[line])) {
        if (matches.length === MAX_DIFF_FIND_MATCHES) return { matches, capped: true }
        matches.push({ key: source.key, line, start: hit.index, end: hit.index + hit[0].length })
      }
    }
  }
  return { matches, capped: false }
}

export function stepMatch(index: number, total: number, delta: 1 | -1): number {
  if (total === 0) return 0
  return (index + delta + total) % total
}

export function lineMarkKey(key: string, line: number): string {
  return `${key}\u0000${line}`
}

export function marksByLine(matches: readonly DiffFindMatch[], active: number): Map<string, DiffTextMarks> {
  const byLine = new Map<string, { ranges: [number, number][]; active: number | null }>()
  matches.forEach((match, index) => {
    const id = lineMarkKey(match.key, match.line)
    let entry = byLine.get(id)
    if (!entry) {
      entry = { ranges: [], active: null }
      byLine.set(id, entry)
    }
    if (index === active) entry.active = entry.ranges.length
    entry.ranges.push([match.start, match.end])
  })
  return byLine
}

export function findCountLabel(result: DiffFindResult, active: number, term: string): string {
  if (term.length === 0) return ''
  if (result.matches.length === 0) return 'No results'
  return `${active + 1}/${result.matches.length}${result.capped ? '+' : ''}`
}

export type DiffMarksLookup = (key: string, line: number) => DiffTextMarks | undefined

export const DiffFindContext = createContext<DiffMarksLookup | null>(null)
