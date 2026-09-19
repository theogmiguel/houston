// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Sidebar } from './Sidebar'
import { MATERIAL_CLS } from './material'
import { setSettingsNavForTests } from '../settingsNav'
import { setBackgroundStateForTests } from '../backgroundMode'

const NOOP = (): void => {}
const THEME_CSS = readFileSync(resolve(__dirname, '..', 'theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

function blockOf(selector: string): Map<string, string> {
  const at = THEME_CSS.indexOf(selector)
  if (at === -1) throw new Error(`theme.css has no "${selector}" block — the selector was renamed; update this test`)
  const open = THEME_CSS.indexOf('{', at)
  const close = THEME_CSS.indexOf('\n}', open)
  const body = THEME_CSS.slice(open + 1, close)
  const out = new Map<string, string>()
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim())
  return out
}

const THEMES: Array<[string, string]> = [
  ['graphite', "[data-theme='graphite']"],
  ['paper', "[data-theme='paper']"],
]

function blockContaining(token: string): Map<string, string> {
  const at = THEME_CSS.indexOf(`${token}:`)
  if (at === -1) throw new Error(`theme.css declares no "${token}" — it was renamed; update this test`)
  const open = THEME_CSS.lastIndexOf('{', at)
  const close = THEME_CSS.indexOf('\n}', open)
  const out = new Map<string, string>()
  for (const m of THEME_CSS.slice(open + 1, close).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim())
  return out
}

describe('every chrome theme cuts its own custom ground', () => {
  const CUSTOM_TOKENS = [
    '--custom-chrome-rgb',
    '--custom-pane-rgb',
    '--custom-chrome-scrim',
    '--custom-pane-scrim',
    '--custom-text-muted',
    '--custom-text-faint',
    '--material-shell-custom-worst'
  ]

  for (const [name, selector] of THEMES) {
    it(`${name} declares every one of them, and none by falling through to another theme`, () => {
      const block = blockOf(selector)
      for (const token of CUSTOM_TOKENS) {
        expect(block.get(token), `${selector} is missing ${token}`).toBeDefined()
      }
    })
  }

  it('the custom ink is re-cut in every theme — both themes now stand on the scrim', () => {
    for (const [name, selector] of THEMES) {
      const block = blockOf(selector)
      expect(block.get('--custom-text-muted') !== block.get('--text-muted'), `${name}: the custom ground is not --rail-bg, so its muted ink must be its own`).toBe(true)
      expect(block.get('--custom-text-faint') !== block.get('--text-faint'), `${name}: the custom ground is not --rail-bg, so its faint ink must be its own`).toBe(true)
    }
  })

  it('each coat is a per-theme triple, and its strength is one shared alpha', () => {
    for (const [name, selector] of THEMES) {
      const block = blockOf(selector)
      expect(block.get('--custom-chrome-rgb'), `${name}: no chrome triple`).toMatch(
        /^\d+,\s*\d+,\s*\d+$/
      )
      expect(block.get('--custom-pane-rgb'), `${name}: no pane triple`).toMatch(
        /^\d+,\s*\d+,\s*\d+$/
      )
      expect(block.get('--custom-chrome-scrim')).toBe(
        'rgba(var(--custom-chrome-rgb), var(--custom-chrome-alpha))'
      )
      expect(block.get('--custom-pane-scrim')).toBe(
        'rgba(var(--custom-pane-rgb), var(--custom-pane-alpha))'
      )
    }
  })

  it('the chrome wears the heavier default coat, and both defaults match the store', () => {
    const block = blockContaining('--custom-chrome-alpha')
    const chrome = Number(block.get('--custom-chrome-alpha'))
    const pane = Number(block.get('--custom-pane-alpha'))
    expect(chrome).toBeGreaterThan(pane)
    expect(chrome).toBeCloseTo(0.72, 5)
    expect(pane).toBeCloseTo(0.35, 5)
  })

  it('a pane stands on the coat, and only the terminal frame stands on nothing', () => {
    const scope = blockOf("[data-custom='on']")
    expect(scope.get('--pane-bg')).toBe('var(--custom-pane-scrim)')
    expect(scope.get('--terminal-frame-bg')).toBe('transparent')
    expect(scope.get('--terminal-coat')).toBe('var(--custom-pane-alpha)')
    const root = blockContaining('--pane-bg')
    expect(root.get('--pane-bg')).toBe('var(--tool-code-bg)')
    expect(root.get('--terminal-frame-bg')).toBe('var(--tool-code-bg)')
    expect(root.get('--terminal-coat')).toBe('1')
  })

  it('the leaves that hold Houston ink read --pane-bg; only the terminal opts out', () => {
    const LEAVES = ['ChangesPane.tsx', 'FilesPane.tsx', 'EditorLeaf.tsx', 'SkillsLeaf.tsx']
    for (const file of LEAVES) {
      const src = readFileSync(resolve(__dirname, file), 'utf8')
      const ground = file === 'ChangesPane.tsx' ? 'bg-[var(--material-shell-bg)]' : 'bg-[var(--pane-bg)]'
      expect(src, `${file} must ground its frame on its panel ground`).toContain(ground)
      expect(src, `${file} is not a terminal and must not read the frame token`).not.toContain(
        '--terminal-frame-bg'
      )
    }
    const terminal = readFileSync(resolve(__dirname, 'SessionPane.tsx'), 'utf8')
    expect(terminal).toContain('bg-[var(--terminal-frame-bg)]')
    expect(terminal).not.toContain('bg-[var(--pane-bg)]')
  })

  it('the skeleton ground is declared in BOTH blocks, never composed from the coat once', () => {
    const root = blockContaining('--terminal-skeleton-bg')
    expect(root.get('--terminal-skeleton-bg')).toBe('var(--tool-code-bg)')
    const scope = blockOf("[data-custom='on']")
    expect(scope.get('--terminal-skeleton-bg'), 'the custom scope must re-declare it').toContain(
      'color-mix'
    )
    expect(scope.get('--terminal-skeleton-bg')).toContain('--custom-pane-alpha')
  })

  it('the sheet-only tokens are gone — the tint moved into the rung', () => {
    expect(THEME_CSS).not.toContain('--glass-surface')
    expect(THEME_CSS).not.toContain('--glass-flatten')
    expect(THEME_CSS).not.toContain('--glass-scrim')
    expect(THEME_CSS).not.toContain('--glass-chrome-bg')
  })

  it('the overlay glass tokens survive — that tier is untouched', () => {
    expect(THEME_CSS).toContain('--glass-blur')
    expect(THEME_CSS).toContain('--glass-saturate')
    expect(THEME_CSS).toContain('--glass-bg:')
    expect(THEME_CSS).toContain('--glass-brd:')
  })

  it('the custom scope re-declares the ink the custom ground needs', () => {
    const scope = blockOf("[data-custom='on']")
    expect(scope.get('--text-muted')).toBe('var(--custom-text-muted)')
    expect(scope.get('--text-faint')).toBe('var(--custom-text-faint)')
    expect(scope.get('--divider')).toBe('var(--hairline)')
    expect(scope.get('--color-text-muted')).toBe('var(--custom-text-muted)')
    expect(scope.get('--color-divider')).toBe('var(--hairline)')
  })

  it('four grounds and nothing else — and the gutters are still the field', () => {
    const scope = blockOf("[data-custom='on']")
    expect(scope.get('--material-shell-bg')).toBe('var(--custom-chrome-scrim)')
    expect(scope.get('--material-shell-worst')).toBe('var(--material-shell-custom-worst)')
    expect(scope.get('--gutter-bg')).toBe('transparent')
    const panel = scope.get('--material-base-bg')
    expect(panel).toContain('var(--custom-chrome-rgb)')
    expect(panel).toContain('var(--custom-chrome-alpha)')
    expect(panel).toContain('min(1')
    expect(scope.get('--material-base-worst')).toBe('var(--material-base-custom-worst)')
    expect(scope.get('--field-plate-bg')).toBe('var(--custom-chrome-scrim)')
    const solid = blockContaining('--gutter-bg')
    expect(solid.get('--gutter-bg')).toBe('var(--rail-bg)')
    expect(solid.get('--field-plate-bg')).toBe('transparent')
    expect(solid.get('--material-base-bg')).toBe('var(--content-bg)')
  })

  it('every theme carries the panel receipt, and the panel is a step past the frame', () => {
    for (const [name, selector] of THEMES) {
      const block = blockOf(selector)
      expect(block.get('--material-base-custom-worst'), `${name}: no panel receipt`).toMatch(
        /^#[0-9a-f]{6}$/
      )
      expect(
        block.get('--material-base-custom-worst') !== block.get('--material-shell-custom-worst'),
        `${name}: the panel is a step past the frame, so its receipt cannot be the frame's`
      ).toBe(true)
    }
  })

  it('every screen that fills a region wears the base rung, never a literal ground', () => {
    const ROOTS: Array<[string, string]> = [
      ['SettingsView.tsx', 'components'],
      ['NewSessionComposer.tsx', 'components'],
      ['FirstRun.tsx', 'components'],
      ['nav/SkillsSurface.tsx', 'components'],
      ['nav/McpSurface.tsx', 'components'],
      ['nav/HooksSurface.tsx', 'components'],
      ['nav/RoutinesSurface.tsx', 'components'],
      ['WorkspacesEmpty.tsx', 'components']
    ]
    for (const [file] of ROOTS) {
      const src = readFileSync(resolve(__dirname, file), 'utf8')
      expect(src, `${file} must wear the rung's class`).toContain('MATERIAL_CLS.base')
      expect(src, `${file} must carry data-material, or it gets the ground and no ink`).toContain(
        "materialAttrs('base')"
      )
      const rootCls = src.split('\n').find((l) => l.includes('MATERIAL_CLS.base')) ?? ''
      expect(rootCls, `${file}: the root must not paint an opaque ground over the picture`)
        .not.toContain('bg-background')
    }
  })

  it('every edge-to-edge screen cuts the same concave corner as the grid', () => {
    expect(THEME_CSS).toContain('.content-region::before')
    expect(THEME_CSS).not.toContain('.agents-region')
    const app = readFileSync(resolve(__dirname, '..', 'App.tsx'), 'utf8')
    const wrappers = app.match(/className="(?:content-region )?absolute inset-0 flex z-\[var\(--z-leaf\)\]"/g) ?? []
    expect(wrappers.length).toBeGreaterThanOrEqual(3)
    for (const w of wrappers) expect(w).toContain('content-region')
  })

  it("a screen's corner is CUT out of the screen, never coated over it", () => {
    expect(THEME_CSS).toMatch(
      /\.content-region::before,\s*\.content-region::after\s*\{\s*z-index:\s*-1;\s*\}/
    )
    expect(THEME_CSS).toMatch(
      /\.grid-region::before,\s*\.grid-region::after\s*\{\s*z-index:\s*var\(--z-base\);\s*\}/
    )
    expect(THEME_CSS).toContain('.grid-region:has(> .content-region)::before')
    expect(THEME_CSS).toContain('.grid-region:has(> .content-region)::after')
    const ROOTS = [
      'SettingsView.tsx',
      'NewSessionComposer.tsx',
      'FirstRun.tsx',
      'WorkspacesEmpty.tsx',
      'nav/SkillsSurface.tsx',
      'nav/McpSurface.tsx',
      'nav/HooksSurface.tsx',
      'nav/RoutinesSurface.tsx'
    ]
    for (const file of ROOTS) {
      const src = readFileSync(resolve(__dirname, file), 'utf8')
      expect(src, `${file} must cut the region's top-left corner`).toContain(
        'rounded-tl-[var(--r-content)]'
      )
      expect(src, `${file} must cut the region's bottom-left corner`).toContain(
        'rounded-bl-[var(--r-content)]'
      )
    }
  })

  it('widens the pane gutter in Custom, because that is where the field shows', () => {
    const solid = blockContaining('--h-top').get('--pane-gutter')
    const custom = blockOf("[data-custom='on']").get('--pane-gutter')
    expect(solid, 'the :root metrics block must define --pane-gutter').toBeDefined()
    expect(custom, "[data-custom='on'] must widen --pane-gutter").toBeDefined()
    expect(parseFloat(custom!)).toBeGreaterThan(parseFloat(solid!))
  })
})

describe('the chrome surfaces stand on the field', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    setSettingsNavForTests({ open: false, section: 'appearance' })
    setBackgroundStateForTests({ mode: 'solid' })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    setBackgroundStateForTests({ mode: 'solid' })
  })

  function render(): HTMLElement {
    act(() => {
      root.render(
        <Sidebar
          workspaces={[{ path: '/p', name: 'proj' }] as never}
          sessions={[]}
          selected="/p"
          customColors={{}}
          colorIndexByPath={{}}
          unreadByWs={{}}
          onSelect={NOOP}
          onAddWorkspace={NOOP}
          onRemoveWorkspace={NOOP}
          onRenameStart={NOOP}
          onRenameSubmit={NOOP}
          onRenameCancel={NOOP}
          onChangeColor={NOOP}
          onReorderWorkspace={NOOP}
          pinnedWorkspaces={new Set()}
          onTogglePinWorkspace={NOOP}
          onSshConnect={NOOP}
          onOpenSettings={NOOP}
          chromeTheme="graphite"
          onToggleChromeTheme={NOOP}
          renaming={null}
        />
      )
    })
    const rail = container.querySelector('aside')
    expect(rail).not.toBeNull()
    return rail as HTMLElement
  }

  it('the rail defers its Custom background to the theme, and blurs nothing itself', () => {
    setBackgroundStateForTests({ mode: 'custom' })
    const rail = render()
    expect(rail.getAttribute('data-custom')).toBe('on')
    expect(rail.className).toContain(MATERIAL_CLS.shell)
    expect(rail.className).not.toContain('backdrop-filter')
  })

  it('draws no right border in Custom or Solid — the tonal step divides', () => {
    setBackgroundStateForTests({ mode: 'custom' })
    const customRail = render()
    expect(customRail.getAttribute('data-custom')).toBe('on')
    expect(customRail.className).not.toContain('border-r')
    expect(customRail.className).not.toContain('backdrop-filter')

    act(() => root.unmount())
    root = createRoot(container)
    setBackgroundStateForTests({ mode: 'solid' })
    const solidRail = render()
    expect(solidRail.getAttribute('data-custom')).toBeNull()
    expect(solidRail.className).not.toContain('border-r')
    expect(solidRail.className).not.toContain('border-[var(--divider)]')
    expect(solidRail.className).not.toContain('backdrop-filter')
  })
})
