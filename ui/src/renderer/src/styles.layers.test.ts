import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHROME_THEME_MODES, CHROME_THEMES } from './theme'

const BASE_CSS_PATH = join(__dirname, 'base.css')
const BASE_LAYER = 'base'

const INHERITED_PROPERTIES = new Set([
  'white-space',
  'font',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'letter-spacing',
  'word-spacing',
  'line-height',
  'color',
  'text-align',
  'text-transform',
  'text-indent',
  'visibility',
  'cursor',
  'word-break',
  'overflow-wrap',
  'list-style'
])

const KNOWN_INHERITED_TRAPS: Record<string, Record<string, string>> = {
  button: {
    'white-space':
      "converted markup adds `whitespace-normal` where old rendering wrapped (see SettingsView.tsx's theme tile) — but this isn't universal: P5 #32 shard 2 shipped several buttons whose wrappable labels inherited this `nowrap` unnoticed and had to be fixed after the fact. Every button carrying wrappable text needs its own reviewed `whitespace-normal`, not an assumption that the conversion already added one. Removable at #33 when preflight lands.",
    font:
      'reset via `font: inherit`; converted buttons set their own Tailwind text utilities (e.g. text-sm) directly on the element, and any differently-styled descendant already carries its own font utility. Removable at #33.',
    cursor:
      '`cursor: pointer` is the intended affordance for the whole button surface; a descendant needing a different cursor already carries its own cursor-* utility. Removable at #33.',
    color:
      "button text color; a converted button nesting a differently-colored child (e.g. a status icon) already carries its own text-* color utility. Removable at #33."
  },
  '.btn': {
    'font-size':
      'same trap and same neutralization as the `button` entry above — a `.btn` carrying wrappable or differently-sized descendant text sets its own text-* utility on that descendant, which wins on layer. Narrower than the element rule it copies: it reaches only buttons that opted in, not every button in the renderer.',
    'font-weight':
      'same trap and same neutralization as the `button` entry above — a descendant needing a different weight carries its own font-* utility. Narrower than the element rule it copies, for the same reason.'
  },
  'button:disabled': {
    cursor:
      '`cursor: not-allowed` on a disabled button; a converted disabled button has no interactive descendant that would need a different cursor. Removable at #33.'
  },
  select: {
    color:
      "B3-5a: the readable-text floor for a form control the UA would otherwise paint white. Its only element descendants are `option`/`optgroup`, which the same rule gives the same color — so there is nothing below it to inherit a value it did not intend. A site wanting different text already carries its own text-* utility and wins on layer."
  },
  option: {
    color:
      "accepted as-is, and the only entry in this table whose property CANNOT leak: `<option>`'s content model is text, so it has no element descendants to inherit into — there is no converted markup to neutralize because there is no markup below it. The declaration exists precisely to be inherited, one level, by the native GTK popup item that renders that text (M-ux-4; see the rule's comment in base.css for the WebKitGTK diagnosis). Not removable: deleting it restores the white-on-white popup."
  },
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) => {
    const newlines = match.match(/\n/g)?.length ?? 0
    return '\n'.repeat(newlines)
  })
}

function extractLayerBlocks(css: string, layerName: string): string[] {
  const blocks: string[] = []
  const marker = `@layer ${layerName}`
  let searchFrom = 0
  while (true) {
    const idx = css.indexOf(marker, searchFrom)
    if (idx === -1) break
    let i = idx + marker.length
    while (i < css.length && /\s/.test(css[i])) i++
    if (css[i] !== '{') {
      searchFrom = idx + marker.length
      continue
    }
    let depth = 0
    let end = -1
    for (let j = i; j < css.length; j++) {
      if (css[j] === '{') depth++
      else if (css[j] === '}') {
        depth--
        if (depth === 0) {
          end = j
          break
        }
      }
    }
    if (end === -1) {
      throw new Error(`Unterminated "@layer ${layerName}" block starting at index ${idx} in ${BASE_CSS_PATH}`)
    }
    blocks.push(css.slice(i + 1, end))
    searchFrom = end + 1
  }
  return blocks
}

interface ParsedRule {
  selectors: string[]
  declarations: { prop: string; value: string }[]
}

function parseRules(blockCss: string): ParsedRule[] {
  const rules: ParsedRule[] = []
  let i = 0
  while (i < blockCss.length) {
    const braceIdx = blockCss.indexOf('{', i)
    if (braceIdx === -1) break
    const selectorText = blockCss.slice(i, braceIdx).trim()
    let depth = 0
    let end = -1
    for (let j = braceIdx; j < blockCss.length; j++) {
      if (blockCss[j] === '{') depth++
      else if (blockCss[j] === '}') {
        depth--
        if (depth === 0) {
          end = j
          break
        }
      }
    }
    if (end === -1) {
      throw new Error(`Unterminated rule starting at index ${braceIdx} inside an @layer base block`)
    }
    const body = blockCss.slice(braceIdx + 1, end)
    if (selectorText.startsWith('@')) {
      rules.push(...parseRules(body))
    } else if (selectorText) {
      const selectors = selectorText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const declarations = body
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => {
          const colonIdx = d.indexOf(':')
          if (colonIdx === -1) return null
          return { prop: d.slice(0, colonIdx).trim(), value: d.slice(colonIdx + 1).trim() }
        })
        .filter((d): d is { prop: string; value: string } => d !== null)
      rules.push({ selectors, declarations })
    }
    i = end + 1
  }
  return rules
}

function findInheritedTraps(rules: ParsedRule[]): { selector: string; property: string }[] {
  const found: { selector: string; property: string }[] = []
  for (const rule of rules) {
    for (const selector of rule.selectors) {
      for (const decl of rule.declarations) {
        const normalizedProp = decl.prop.trim().replace(/\s+/g, ' ').toLowerCase()
        if (INHERITED_PROPERTIES.has(normalizedProp)) {
          found.push({ selector: selector.trim().replace(/\s+/g, ' ').toLowerCase(), property: normalizedProp })
        }
      }
    }
  }
  return found
}

describe('base.css @layer base inheritance traps', () => {
  const raw = readFileSync(BASE_CSS_PATH, 'utf8')
  const stripped = stripComments(raw)
  const blocks = extractLayerBlocks(stripped, BASE_LAYER)

  it('found at least one "@layer base" block (sanity check against a rename/removal)', () => {
    expect(blocks.length).toBeGreaterThan(0)
  })

  const allRules = blocks.flatMap((block) => parseRules(block))
  const totalDeclarations = allRules.reduce((sum, rule) => sum + rule.declarations.length, 0)

  it('parsed at least one rule out of @layer base (sanity check against a broken selector/brace parse)', () => {
    if (allRules.length === 0) {
      throw new Error(
        `Parsed zero rules out of ${blocks.length} "@layer base" block(s) in ${BASE_CSS_PATH} — ` +
          `the rule parser (parseRules) found nothing to work with. This would make every later assertion in ` +
          `this file vacuously true over zero coverage.`
      )
    }
    expect(allRules.length).toBeGreaterThan(0)
  })

  it('parsed at least one declaration inside @layer base (sanity check against a broken declaration parse)', () => {
    if (totalDeclarations === 0) {
      throw new Error(
        `Parsed zero declarations out of ${allRules.length} rule(s) inside "@layer base" in ${BASE_CSS_PATH} — ` +
          `the declaration parser (body.split(';')) found nothing to work with. This would make every ` +
          `inherited-property assertion in this file vacuously true over zero coverage.`
      )
    }
    expect(totalDeclarations).toBeGreaterThan(0)
  })

  const found = findInheritedTraps(allRules)

  it('found a non-trivial number of inherited declarations inside @layer base (sanity check)', () => {
    expect(found.length).toBeGreaterThan(0)
  })

  it('every inherited property declared inside @layer base has a KNOWN_INHERITED_TRAPS entry', () => {
    const missing = found.filter((f) => !KNOWN_INHERITED_TRAPS[f.selector]?.[f.property])

    if (missing.length > 0) {
      const details = missing.map((f) => `  ${f.selector} → ${f.property}`).join('\n')
      throw new Error(
        `Inherited propert${missing.length === 1 ? 'y' : 'ies'} declared inside @layer base with no ` +
          `KNOWN_INHERITED_TRAPS entry:\n${details}\n\n` +
          `@layer only fixes specificity (a Tailwind utility on the element itself wins); it does nothing about ` +
          `inheritance, so a converted surface will silently inherit this property from styles.css's legacy layer ` +
          `into any descendant no utility targets. Add an entry to KNOWN_INHERITED_TRAPS keyed selector → property ` +
          `describing how converted markup neutralizes it (or why it is accepted as-is).`
      )
    }

    expect(missing.length).toBe(0)
  })

  it('KNOWN_INHERITED_TRAPS has no stale entries (selector/property no longer both present and inherited)', () => {
    for (const [selector, props] of Object.entries(KNOWN_INHERITED_TRAPS)) {
      for (const property of Object.keys(props)) {
        const stillPresent = found.some((f) => f.selector === selector && f.property === property)
        expect(
          stillPresent,
          `${selector} → ${property} is in KNOWN_INHERITED_TRAPS but is no longer an inherited property declared ` +
            `inside @layer base — remove the stale entry`
        ).toBe(true)
      }
    }
  })

  it('.btn is the flex row its icon+label call sites assume', () => {
    const btn = allRules.find((r) => r.selectors.includes('.btn'))
    expect(btn, 'the .btn rule').toBeDefined()
    const declarations = new Map(btn!.declarations.map((d) => [d.prop.toLowerCase(), d.value]))
    expect(
      declarations.get('display'),
      'Icon.tsx renders block, so a .btn without a flex display stacks the label under the icon'
    ).toBe('inline-flex')
    expect(declarations.get('align-items')).toBe('center')
  })
})

describe('parseRules / extractLayerBlocks regression coverage', () => {
  it('finding 1: attributes declarations inside a nested at-rule to their nearest rule selector, not the at-rule prelude', () => {
    const css = `
      @layer base {
        @media (max-width: 700px) {
          button { color: red; white-space: nowrap }
        }
      }
    `
    const blocks = extractLayerBlocks(css, 'base')
    expect(blocks.length).toBe(1)

    const rules = parseRules(blocks[0])
    expect(rules.some((r) => r.selectors.some((s) => s.startsWith('@media')))).toBe(false)

    const buttonRule = rules.find((r) => r.selectors.includes('button'))
    expect(buttonRule).toBeDefined()
    const props = buttonRule?.declarations.map((d) => d.prop) ?? []
    expect(props).toContain('color')
    expect(props).toContain('white-space')
  })

  it('finding 2: matches inherited properties and registry selectors case-insensitively', () => {
    const css = `
      @layer base {
        Button { Color: red; }
      }
    `
    const blocks = extractLayerBlocks(css, 'base')
    const rules = parseRules(blocks[0])
    const found = findInheritedTraps(rules)

    expect(found).toContainEqual({ selector: 'button', property: 'color' })
  })
})

describe('theme.css color-scheme coverage', () => {
  const THEME_CSS_PATH = join(__dirname, 'theme.css')
  const raw = readFileSync(THEME_CSS_PATH, 'utf8')
  const stripped = stripComments(raw)

  function readDeclaredColorSchemes(css: string): Map<string, string> {
    const out = new Map<string, string>()
    const blockRe = /((?::root,\s*)?\[data-theme='([^']+)'\])\s*\{/g
    let m: RegExpExecArray | null
    while ((m = blockRe.exec(css)) !== null) {
      const name = m[2]
      const bodyStart = m.index + m[0].length
      let depth = 1
      let i = bodyStart
      while (i < css.length && depth > 0) {
        if (css[i] === '{') depth++
        else if (css[i] === '}') depth--
        i++
      }
      const body = css.slice(bodyStart, i - 1)
      const schemeMatch = body.match(/color-scheme\s*:\s*(dark|light)\s*;/)
      if (schemeMatch) out.set(name, schemeMatch[1])
    }
    return out
  }

  const declared = readDeclaredColorSchemes(stripped)

  it('found at least one color-scheme declaration (sanity check against a broken parse)', () => {
    expect(declared.size).toBeGreaterThan(0)
  })

  it('every theme in CHROME_THEMES declares a color-scheme in theme.css matching its CHROME_THEME_MODES entry', () => {
    const mismatches: string[] = []
    for (const name of CHROME_THEMES) {
      const expectedMode = CHROME_THEME_MODES[name]
      const actual = declared.get(name)
      if (actual === undefined) {
        mismatches.push(`${name}: no color-scheme declaration found (expected "${expectedMode}")`)
      } else if (actual !== expectedMode) {
        mismatches.push(`${name}: declared color-scheme "${actual}", CHROME_THEME_MODES says "${expectedMode}"`)
      }
    }
    expect(mismatches, mismatches.join('\n')).toEqual([])
  })

  it('has no color-scheme declaration for a theme name not in CHROME_THEMES (stale/typo guard)', () => {
    const known = new Set<string>(CHROME_THEMES)
    const unknown = [...declared.keys()].filter((name) => !known.has(name))
    expect(unknown, `color-scheme declared for unknown theme name(s): ${unknown.join(', ')}`).toEqual([])
  })
})

describe('base.css comment hygiene', () => {
  const raw = readFileSync(BASE_CSS_PATH, 'utf8')

  it('has no comment that closes early (a stray `*/` swallows the next rule)', () => {
    const outsideComments = raw.replace(/\/\*[\s\S]*?\*\//g, '')
    const stray = outsideComments.indexOf('*/')
    const context =
      stray === -1 ? '' : JSON.stringify(outsideComments.slice(Math.max(0, stray - 120), stray + 40))
    expect(
      stray,
      `found a stray "*/" outside any comment — a comment closed early and the ` +
        `rule after it is being discarded by the parser. Context: ${context}`
    ).toBe(-1)
  })
})
