import { describe, expect, it } from 'vitest'
import {
  bootClosure,
  checkBudget,
  matchesForbidden,
  matchesForbiddenPath
} from './check-bundle-budget.mjs'

function chunk(fileName, over = {}) {
  return {
    fileName,
    bytes: 100,
    isEntry: false,
    facade: null,
    imports: [],
    dynamicImports: [],
    packages: [],
    appModules: [],
    ...over
  }
}

describe('matchesForbidden', () => {
  it('matches exact names and prefix globs, and nothing else', () => {
    expect(matchesForbidden('react-markdown', 'react-markdown')).toBe(true)
    expect(matchesForbidden('react-markdown-extra', 'react-markdown')).toBe(false)
    expect(matchesForbidden('@codemirror/lang-rust', '@codemirror/lang-*')).toBe(true)
    expect(matchesForbidden('@codemirror/language', '@codemirror/lang-*')).toBe(false)
  })
})

describe('matchesForbiddenPath', () => {
  it('treats a trailing slash as a directory rule', () => {
    const rule = 'src/renderer/src/ghostty/'
    expect(matchesForbiddenPath('src/renderer/src/ghostty/core.ts', rule)).toBe(true)
    expect(matchesForbiddenPath('src/renderer/src/ghostty/vendor/ghostty-vt.wasm', rule)).toBe(true)
    expect(matchesForbiddenPath('src/renderer/src/ghostty-spike/core.ts', rule)).toBe(false)
  })

  it('treats a trailing star as a prefix rule and a bare path as exact', () => {
    expect(matchesForbiddenPath('src/renderer/src/ghostty-spike/core.ts', 'src/renderer/src/ghostty*')).toBe(true)
    const exact = 'src/renderer/src/pane/ghosttyOverlay.ts'
    expect(matchesForbiddenPath(exact, exact)).toBe(true)
    expect(matchesForbiddenPath('src/renderer/src/pane/ghosttyOverlay.test.ts', exact)).toBe(false)
  })
})

describe('bootClosure', () => {
  it('follows static imports transitively and ignores dynamic ones', () => {
    const stats = {
      entry: 'entry.js',
      chunks: [
        chunk('entry.js', { isEntry: true, imports: ['shared.js'], dynamicImports: ['lazy.js'] }),
        chunk('shared.js', { imports: ['deep.js'] }),
        chunk('deep.js'),
        chunk('lazy.js', { packages: ['react-markdown'] })
      ]
    }
    const { order } = bootClosure(stats)
    expect(order).toEqual(['entry.js', 'shared.js', 'deep.js'])
  })

  it('names the missing chunk when stats are inconsistent', () => {
    const stats = {
      entry: 'entry.js',
      chunks: [chunk('entry.js', { isEntry: true, imports: ['gone.js'] })]
    }
    expect(() => bootClosure(stats)).toThrow(/chunk "gone\.js" is imported but not listed/)
  })
})

describe('checkBudget', () => {
  const budget = { maxBootBytes: 250, forbiddenBootPackages: ['react-markdown', '@codemirror/lang-*'] }

  it('passes a clean build and reports nothing', () => {
    const stats = {
      entry: 'entry.js',
      chunks: [
        chunk('entry.js', { isEntry: true, dynamicImports: ['lazy.js'], packages: ['react'] }),
        chunk('lazy.js', { packages: ['react-markdown', '@codemirror/lang-rust'] })
      ]
    }
    expect(checkBudget(stats, budget)).toEqual([])
  })

  it('names the package, the rule, and the import chain when a forbidden package reaches boot', () => {
    const stats = {
      entry: 'entry.js',
      chunks: [
        chunk('entry.js', { isEntry: true, imports: ['shared.js'] }),
        chunk('shared.js', { packages: ['@codemirror/lang-rust'] })
      ]
    }
    const violations = checkBudget(stats, budget)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('"@codemirror/lang-rust"')
    expect(violations[0]).toContain('rule "@codemirror/lang-*"')
    expect(violations[0]).toContain('entry.js -> shared.js')
  })

  it('names the limit, the actual bytes, and the fix when the boot payload is over budget', () => {
    const stats = {
      entry: 'entry.js',
      chunks: [
        chunk('entry.js', { isEntry: true, imports: ['shared.js'], bytes: 200 }),
        chunk('shared.js', { bytes: 100 })
      ]
    }
    const violations = checkBudget(stats, budget)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('300 bytes')
    expect(violations[0]).toContain('250-byte budget')
  })
})

describe('checkBudget forbiddenBootPaths', () => {
  const budget = {
    maxBootBytes: 1000,
    forbiddenBootPackages: [],
    forbiddenBootPaths: ['src/renderer/src/ghostty/', 'src/renderer/src/pane/ghosttyOverlay.ts']
  }

  it('passes when the ghostty engine is only behind a dynamic import', () => {
    const stats = {
      entry: 'entry.js',
      chunks: [
        chunk('entry.js', {
          isEntry: true,
          dynamicImports: ['overlay.js'],
          appModules: ['src/renderer/src/pane/TerminalPane.tsx']
        }),
        chunk('overlay.js', {
          appModules: [
            'src/renderer/src/pane/ghosttyOverlay.ts',
            'src/renderer/src/ghostty/core.ts',
            'src/renderer/src/ghostty/runtime.ts'
          ]
        })
      ]
    }
    expect(checkBudget(stats, budget)).toEqual([])
  })

  it('names the module, the rule, and the import chain when a static import pulls it to boot', () => {
    const stats = {
      entry: 'entry.js',
      chunks: [
        chunk('entry.js', { isEntry: true, imports: ['shared.js'] }),
        chunk('shared.js', { appModules: ['src/renderer/src/ghostty/core.ts'] })
      ]
    }
    const violations = checkBudget(stats, budget)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('"src/renderer/src/ghostty/core.ts"')
    expect(violations[0]).toContain('rule "src/renderer/src/ghostty/"')
    expect(violations[0]).toContain('entry.js -> shared.js')
  })

  it('refuses a stats file that predates appModules instead of passing every path rule', () => {
    const legacy = { fileName: 'entry.js', bytes: 10, isEntry: true, imports: [], dynamicImports: [], packages: [] }
    const stats = { entry: 'entry.js', chunks: [legacy] }
    expect(() => checkBudget(stats, budget)).toThrow(/no "appModules" field/)
    expect(checkBudget(stats, { ...budget, forbiddenBootPaths: [] })).toEqual([])
  })
})
