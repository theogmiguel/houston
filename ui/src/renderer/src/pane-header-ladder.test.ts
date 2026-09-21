import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SESSION_PANE_PATH = join(__dirname, 'components', 'SessionPane.tsx')
const sessionPaneSrc = readFileSync(SESSION_PANE_PATH, 'utf8')
const RENAME_TITLE_PATH = join(__dirname, 'components', 'RenameTitle.tsx')
const renameTitleSrc = readFileSync(RENAME_TITLE_PATH, 'utf8')

function shedStepForTestid(testid: string): number | undefined {
  const anchor = `data-testid="${testid}"`
  const idx = sessionPaneSrc.indexOf(anchor)
  expect(idx, `could not find data-testid="${testid}" in SessionPane.tsx`).toBeGreaterThan(-1)
  const classNameIdx = sessionPaneSrc.indexOf('className', idx)
  const windowEnd = sessionPaneSrc.indexOf('>', classNameIdx)
  const window = sessionPaneSrc.slice(classNameIdx, windowEnd === -1 ? undefined : windowEnd)
  const m = window.match(/\[@container_\(max-width:(\d+)px\)\]:hidden/)
  return m ? Number(m[1]) : undefined
}

function extractPaneTitleCls(): string {
  const idx = renameTitleSrc.indexOf('const PANE_TITLE_CLS =')
  expect(idx, 'could not find `const PANE_TITLE_CLS =` in RenameTitle.tsx').toBeGreaterThan(-1)
  const quoteStart = renameTitleSrc.indexOf('"', idx)
  const quoteEnd = renameTitleSrc.indexOf('"', quoteStart + 1)
  expect(quoteStart, 'could not find the opening quote of PANE_TITLE_CLS').toBeGreaterThan(-1)
  expect(quoteEnd, 'could not find the closing quote of PANE_TITLE_CLS').toBeGreaterThan(quoteStart)
  return renameTitleSrc.slice(quoteStart + 1, quoteEnd)
}

describe('pane header container-query ladder (SessionPane.tsx / RenameTitle.tsx)', () => {
  it('parsed a non-trivial number of container bands out of PANE_TITLE_CLS (sanity check the extraction itself works)', () => {
    const cls = extractPaneTitleCls()
    const bandCount = (cls.match(/\[@container_\((?:min|max)-width:\d+px\)\]:/g) ?? []).length
    expect(bandCount).toBeGreaterThanOrEqual(8)
  })

  const MIN_SHED_THRESHOLD_PX = {
    state: 490,
    paneSub: 400,
    engineGlyph: 360
  } as const

  it(`sheds \`.state\` at max-width >= ${MIN_SHED_THRESHOLD_PX.state}px`, () => {
    const px = shedStepForTestid('pane-state')
    expect(
      px,
      'expected SessionPane.tsx\'s `data-testid="pane-state"` element to carry a ' +
        '`[@container_(max-width:Npx)]:hidden` step — ' +
        "a dead session's state chip was never budgeted by the original ladder, and its fixed " +
        'width can overflow a narrow header on its own'
    ).toBeDefined()
    expect(
      px!,
      `.state is shed at max-width: ${px}px, but measurement requires >= ` +
        `${MIN_SHED_THRESHOLD_PX.state}px (\`.state\` alone clipped close at 390-420px) — this ` +
        'step regressed narrower than what was measured safe'
    ).toBeGreaterThanOrEqual(MIN_SHED_THRESHOLD_PX.state)
  })

  it(`sheds \`.pane-sub\` at max-width >= ${MIN_SHED_THRESHOLD_PX.paneSub}px`, () => {
    const px = shedStepForTestid('pane-sub')
    expect(px, 'expected a `[@container_(max-width:Npx)]:hidden` step on `data-testid="pane-sub"`').toBeDefined()
    expect(
      px!,
      `.pane-sub is shed at max-width: ${px}px, but measurement requires >= ` +
        `${MIN_SHED_THRESHOLD_PX.paneSub}px (\`.pane-sub\` alone clipped close by ~2px at 380px ` +
        'once `.state` was already shed) — this step regressed narrower than what was ' +
        'measured safe'
    ).toBeGreaterThanOrEqual(MIN_SHED_THRESHOLD_PX.paneSub)
  })

  it(`sheds \`[data-testid="engine-glyph"]\` at max-width >= ${MIN_SHED_THRESHOLD_PX.engineGlyph}px`, () => {
    const px = shedStepForTestid('engine-glyph')
    expect(
      px,
      'expected SessionPane.tsx\'s `data-testid="engine-glyph"` element to carry a ' +
        '`[@container_(max-width:Npx)]:hidden` step — the charter\'s 360px tier ' +
        '("engine glyph") has nothing to shed until this element exists'
    ).toBeDefined()
    expect(
      px!,
      `engine-glyph is shed at max-width: ${px}px, but the charter specifies ` +
        `${MIN_SHED_THRESHOLD_PX.engineGlyph}px for this tier — this step regressed narrower ` +
        'than what the charter specifies'
    ).toBeGreaterThanOrEqual(MIN_SHED_THRESHOLD_PX.engineGlyph)
  })

  it('sheds `.branch-chip` at max-width >= 400px, and renders no `.header-divider`', () => {
    const px = shedStepForTestid('branch-chip')
    expect(
      px,
      'expected SessionPane.tsx\'s `data-testid="branch-chip"` element to carry a ' +
        '`[@container_(max-width:Npx)]:hidden` step — the chip joins `.pane-sub` at the 400px tier'
    ).toBeDefined()
    expect(px!).toBeGreaterThanOrEqual(400)
    expect(sessionPaneSrc).not.toContain('data-testid="header-divider"')
  })

  it('never declares `.pane-title`\'s max-width as 0 in any container band', () => {
    const cls = extractPaneTitleCls()
    const re = /\[@container_\((?:min|max)-width:(\d+)px\)\]:max-w-\[(\d+)px\]/g
    let m: RegExpExecArray | null
    let bandCount = 0
    while ((m = re.exec(cls)) !== null) {
      bandCount++
      const bandPx = Number(m[1])
      const maxWidthPx = Number(m[2])
      expect(
        maxWidthPx,
        `the ${bandPx}px container band sets .pane-title max-width to ${maxWidthPx}px — ` +
          'the title must always be allowed some non-zero width'
      ).toBeGreaterThan(0)
    }
    expect(bandCount).toBeGreaterThanOrEqual(8)
  })

  it('`PANE_TITLE_CLS` declares a non-zero base min-width (the actual shrink-to-zero cause)', () => {
    const cls = extractPaneTitleCls()
    const m = cls.match(/(?:^|\s)min-w-\[(\d+)px\]/)
    expect(
      m,
      'PANE_TITLE_CLS has no bare `min-w-[Npx]` utility — without one the flexbox shrink ' +
        'algorithm starves the title to zero width whenever fixed-size siblings (chips, action ' +
        'icons) outgrow the header'
    ).not.toBeNull()
    expect(Number(m![1])).toBeGreaterThan(0)
  })
})
