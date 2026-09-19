#!/usr/bin/env node

import { chromium } from 'playwright'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rendererSrcDir = join(__dirname, '..', 'src', 'renderer', 'src')
const outAssetsDir = join(__dirname, '..', 'out', 'renderer', 'assets')
const EXPECTED_CHROME_PATH = '/usr/bin/google-chrome'

function fail(message) {
  console.error(message)
  process.exit(1)
}

function readThemeNames() {
  const themeTsPath = join(rendererSrcDir, 'theme.ts')
  const src = readFileSync(themeTsPath, 'utf8')
  const m = src.match(/export const CHROME_THEMES\s*=\s*\[([\s\S]*?)\]\s*as const/)
  if (!m) {
    fail(`Could not find "export const CHROME_THEMES = [...] as const" in ${themeTsPath} — theme.ts's export shape changed; update the regex in check-css-scoping.mjs.`)
  }
  const names = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  if (names.length === 0) {
    fail(`Parsed zero theme names out of CHROME_THEMES in ${themeTsPath} — expected at least one 'name' string literal.`)
  }
  return names
}

function readColorTokenMappings() {
  const tailwindCssPath = join(rendererSrcDir, 'tailwind.css')
  const src = readFileSync(tailwindCssPath, 'utf8')
  const themeBlockMatch = src.match(/@theme\s*\{([\s\S]*?)\n\}/)
  if (!themeBlockMatch) {
    fail(`Could not find an "@theme { ... }" block in ${tailwindCssPath} — update the regex in check-css-scoping.mjs if the block's shape changed.`)
  }
  const block = themeBlockMatch[1]
  const mappings = new Map()
  for (const m of block.matchAll(/(--color-[a-zA-Z0-9-]+)\s*:\s*var\((--[a-zA-Z0-9-]+)\)/g)) {
    mappings.set(m[1], m[2])
  }
  if (mappings.size === 0) {
    fail(`Parsed zero "--color-X: var(--Y)" mappings out of @theme in ${tailwindCssPath} — expected at least one.`)
  }
  return mappings
}

function readMaterialRecipes() {
  const path = join(rendererSrcDir, 'components', 'material.ts')
  const src = readFileSync(path, 'utf8')
  const block = src.match(/export const MATERIAL_CLS[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\n\}\)/)
  if (!block) {
    fail(`Could not find "export const MATERIAL_CLS … = Object.freeze({ … })" in ${path} — update the regex in check-css-scoping.mjs if its shape changed.`)
  }
  const consts = new Map()
  for (const m of src.matchAll(/^const ([A-Z0-9_]+)\s*=([\s\S]*?)\n\n/gm)) {
    consts.set(m[1], [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1]).join(''))
  }
  const recipes = new Map()
  for (const m of block[1].matchAll(/(?:^|\n)\s*'?([a-z-]+)'?\s*:([\s\S]*?)(?=\n\s*'?[a-z-]+'?\s*:|$)/g)) {
    let body = m[2]
    for (const [name, value] of consts) body = body.split('${' + name + '}').join(value)
    const unresolved = body.match(/\$\{([A-Za-z0-9_]+)\}/)
    if (unresolved) {
      fail(`MATERIAL_CLS entry "${m[1]}" in ${path} interpolates \${${unresolved[1]}}, which is not a top-level "const ${unresolved[1]} = …" in the same file — check-css-scoping.mjs resolves interpolations one level deep only.`)
    }
    let text = ''
    for (const tok of body.matchAll(/'([^']*)'|`([^`]*)`/g)) text += tok[1] !== undefined ? tok[1] : tok[2]
    const classes = text.trim().split(/\s+/).filter(Boolean)
    if (classes.length === 0) {
      fail(`Parsed zero classes for material "${m[1]}" in ${path} — every rung must spell at least a ground.`)
    }
    recipes.set(m[1], classes)
  }
  if (recipes.size === 0) {
    fail(`Parsed zero materials out of MATERIAL_CLS in ${path} — expected one entry per rung.`)
  }
  return recipes
}

function readBackgroundBounds() {
  const path = join(rendererSrcDir, 'backgroundMode.ts')
  const src = readFileSync(path, 'utf8')
  const ceiling = src.match(/loadBounded\(CEILING_KEY,[^)]*?,\s*(\d+),\s*(\d+)\)/)
  const scrim = src.match(/loadBounded\(CHROME_SCRIM_KEY,[^)]*?,\s*(\d+),\s*(\d+)\)/)
  if (!ceiling || !scrim) {
    fail(`Could not parse the ceiling/scrim bounds out of ${path} — check-css-scoping.mjs reads them from the loadBounded(CEILING_KEY, ...) and loadBounded(CHROME_SCRIM_KEY, ...) calls. If backgroundMode.ts's shape changed, update the regex.`)
  }
  return { ceilingMax: Number(ceiling[2]), scrimMin: Number(scrim[1]) }
}

function newestBuiltStylesheet() {
  if (!existsSync(outAssetsDir)) {
    fail(`Build output directory does not exist: ${outAssetsDir} — run "bun run build" before "bun run check:css".`)
  }
  const cssFiles = readdirSync(outAssetsDir).filter((f) => f.endsWith('.css'))
  if (cssFiles.length === 0) {
    fail(`No .css files found in ${outAssetsDir} — run "bun run build" before "bun run check:css".`)
  }
  const withMtime = cssFiles.map((f) => ({
    path: join(outAssetsDir, f),
    mtimeMs: statSync(join(outAssetsDir, f)).mtimeMs
  }))
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return withMtime[0].path
}

function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

function readCanonicalLayerOrder() {
  const tailwindCssPath = join(rendererSrcDir, 'tailwind.css')
  const src = stripCssComments(readFileSync(tailwindCssPath, 'utf8'))
  const m = src.match(/@layer\s+([a-zA-Z0-9_-]+(?:\s*,\s*[a-zA-Z0-9_-]+)+)\s*;/)
  if (!m) {
    fail(`Could not find a canonical "@layer a, b, ...;" order statement in ${tailwindCssPath} — the layer-order gate cannot run. If the statement moved or changed shape, update the regex in check-css-scoping.mjs.`)
  }
  return m[1].split(',').map((s) => s.trim())
}

function checkLayerOrder(cssContent, cssPath) {
  const canonical = readCanonicalLayerOrder()
  const css = stripCssComments(cssContent)

  const seen = []
  const register = (name) => {
    if (name && !seen.includes(name)) seen.push(name)
  }
  for (const m of css.matchAll(/@layer\s+([^;{]*?)\s*([;{])/g)) {
    const names = m[1].trim()
    if (!names) continue
    if (m[2] === ';') names.split(',').forEach((n) => register(n.trim()))
    else register(names)
  }

  if (seen.length === 0) {
    fail(`No @layer at-rules found in ${cssPath}. tailwind.css declares "${canonical.join(', ')}", so the built sheet should contain them — the build may not be emitting the renderer's CSS.`)
  }

  const unknown = seen.filter((n) => !canonical.includes(n))
  if (unknown.length > 0) {
    fail(
      `Built stylesheet ${cssPath} registers layer(s) not named in tailwind.css's canonical order: ${unknown.join(', ')}.\n` +
        `Canonical order: ${canonical.join(', ')}\n` +
        `Effective order: ${seen.join(', ')}\n\n` +
        `An undeclared layer takes its position from wherever it is first emitted, which may put it above "utilities". ` +
        `Add it to the canonical statement in tailwind.css at its intended position.`
    )
  }

  const effective = seen.filter((n) => canonical.includes(n))
  const expected = canonical.filter((n) => effective.includes(n))
  if (effective.join(',') !== expected.join(',')) {
    const firstDivergence = effective.findIndex((n, i) => n !== expected[i])
    fail(
      `Built stylesheet ${cssPath} has the wrong effective @layer order.\n` +
        `  expected: ${expected.join(' < ')}\n` +
        `  actual:   ${effective.join(' < ')}\n` +
        `  first divergence at position ${firstDivergence + 1}: expected "${expected[firstDivergence]}", got "${effective[firstDivergence]}"\n\n` +
        `A layer's position is fixed where it is FIRST seen in the bundle, not by the order statement in tailwind.css. ` +
        `A stylesheet that opens a layer before that statement is emitted registers it too early, and it loses to every layer above it. ` +
        `Fix: restate the canonical order statement at the top of the stylesheet that opens the layer (swarm.css does this) — ` +
        `restating is idempotent and, unlike reordering imports, independent of bundler order.`
    )
  }

  return { canonical, effective }
}

async function main() {
  const bounds = readBackgroundBounds()
  const themes = readThemeNames()
  const mappings = readColorTokenMappings()
  const cssPath = newestBuiltStylesheet()
  const cssContent = readFileSync(cssPath, 'utf8')
  if (cssContent.trim().length === 0) {
    fail(`Loaded stylesheet ${cssPath} is empty — the build output found nothing to check. Run "bun run build" and verify it emitted CSS.`)
  }

  const { effective } = checkLayerOrder(cssContent, cssPath)

  let browser
  try {
    browser = await chromium.launch({ channel: 'chrome' })
  } catch (err) {
    fail(
      `Could not launch system Chrome via Playwright's channel: 'chrome' (expected at ${EXPECTED_CHROME_PATH}): ${err.message}\n` +
        `Do not fall back to a downloaded browser — install/verify Chrome at that path instead.`
    )
    return
  }

  const LEGIBILITY_TOKENS = ['--text-primary', '--background', '--surface', '--raised', '--focus-ring']

  const MATERIAL_INK_TOKENS = ['--text-primary', '--text-secondary', '--text-muted', '--text-faint']
  const materials = readMaterialRecipes()
  const MATERIAL_NAMES = [...materials.keys()]

  const FIELD_W = 1920
  const FIELD_H = 1500
  const BOX_W_MAX = 560
  const BOX_H = 96
  const BOX_GAP = 64
  const BOX_INSET = 3

  function materialRegions() {
    const boxW = Math.min(BOX_W_MAX, FIELD_W - BOX_GAP * 2)
    if (boxW <= 0) {
      fail(`The material ladder no longer fits the ground probe: a ${boxW}x${BOX_H} box does not fit ${FIELD_W}px — shrink BOX_H or BOX_W_MAX.`)
    }
    const x = Math.round((FIELD_W - boxW) / 2)
    const probes = new Map()
    let y = BOX_GAP
    for (const name of MATERIAL_NAMES) {
      probes.set(name, [
        {
          x,
          y,
          w: boxW,
          h: BOX_H,
          patch: name !== 'base' && name !== 'shell'
        }
      ])
      y += BOX_H + BOX_GAP
    }
    return probes
  }

  let results
  let legibility
  let ladder
  const measured = {}
  const groundErrors = []
  try {
    const page = await browser.newPage()
    await page.setContent('<!doctype html><html><head></head><body></body></html>')
    await page.addStyleTag({ content: cssContent })

    results = await page.evaluate(
      ({ themes, mappingEntries }) => {
        const mappings = new Map(mappingEntries)
        const out = {}
        const probe = document.createElement('div')
        document.body.appendChild(probe)
        for (const theme of themes) {
          probe.setAttribute('data-theme', theme)
          const cs = getComputedStyle(probe)
          const perTheme = {}
          for (const [colorVar, sourceVar] of mappings) {
            perTheme[colorVar] = {
              value: cs.getPropertyValue(colorVar).trim(),
              sourceValue: cs.getPropertyValue(sourceVar).trim()
            }
          }
          out[theme] = perTheme
        }
        probe.remove()
        return out
      },
      { themes, mappingEntries: [...mappings.entries()] }
    )

    legibility = await page.evaluate(
      ({ themes, tokens }) => {
        const out = {}
        const probe = document.createElement('div')
        document.body.appendChild(probe)
        for (const theme of themes) {
          probe.setAttribute('data-theme', theme)
          const cs = getComputedStyle(probe)
          const perTheme = {}
          for (const token of tokens) perTheme[token] = cs.getPropertyValue(token).trim()
          out[theme] = perTheme
        }
        probe.remove()
        return out
      },
      { themes, tokens: LEGIBILITY_TOKENS }
    )

    ladder = await page.evaluate(
      ({ themes, names, tokens }) => {
        const out = {}
        const themed = document.createElement('div')
        document.body.appendChild(themed)
        const scoped = document.createElement('div')
        themed.appendChild(scoped)
        const resolve = (el, token) => {
          el.style.color = `var(${token})`
          const value = getComputedStyle(el).color
          el.style.color = ''
          return value
        }
        for (const theme of themes) {
          themed.setAttribute('data-theme', theme)
          const perTheme = {}
          for (const name of names) {
            for (const customOn of [false, true]) {
              scoped.setAttribute('data-material', name)
              if (customOn) scoped.setAttribute('data-custom', 'on')
              else scoped.removeAttribute('data-custom')
              const ink = {}
              for (const token of tokens) ink[token] = resolve(scoped, token)
              perTheme[customOn ? `${name}@custom` : name] = {
                ink,
                worst: resolve(scoped, `--material-${name}-worst`),
                bg: resolve(scoped, `--material-${name}-bg`)
              }
            }
          }
          out[theme] = perTheme
        }
        themed.remove()
        return out
      },
      { themes, names: MATERIAL_NAMES, tokens: MATERIAL_INK_TOKENS }
    )

    const darkByTheme = {}
    for (const theme of themes) {
      const ink = parseRgb(legibility[theme]['--text-primary'])
      const ground = parseRgb(legibility[theme]['--background'])
      darkByTheme[theme] =
        ink !== null && ground !== null ? relativeLuminance(ink) > relativeLuminance(ground) : true
    }

    const scrimMin = bounds.scrimMin / 100
    const scrimRgb = await page.evaluate(
      ({ themes }) => {
        const out = {}
        const probe = document.createElement('div')
        document.body.appendChild(probe)
        for (const theme of themes) {
          probe.setAttribute('data-theme', theme)
          out[theme] = getComputedStyle(probe).getPropertyValue('--custom-chrome-scrim').trim()
        }
        probe.remove()
        return out
      },
      { themes }
    )
    const parseScrim = (value) => {
      const m = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
      if (!m) {
        fail(`--custom-chrome-scrim resolved to ${JSON.stringify(value)} in a theme — expected an rgb()/rgba() literal.`)
      }
      return [Number(m[1]), Number(m[2]), Number(m[3])]
    }

    const fieldFor = (dark, q) => {
      const ceil = bounds.ceilingMax / 100
      const outv = dark ? q * ceil : 1 - (1 - q) * ceil
      return Math.round(outv * 255)
    }

    for (const theme of themes) {
      const dark = darkByTheme[theme]
      const scrim = parseScrim(scrimRgb[theme])
      measured[theme] = {}
      const passes = [
        { key: (name) => name, custom: false },
        { key: (name) => `${name}@custom`, custom: true, field: fieldFor(dark, 1) },
        { key: (name) => `${name}@custom`, custom: true, field: fieldFor(dark, 0) }
      ]
      const layouts = materialRegions()
      for (const pass of passes) {
        await page.setViewportSize({ width: FIELD_W, height: FIELD_H })
        await page.setContent(
          `<!doctype html><html><head></head><body><div id="root" data-theme="${theme}"${
            pass.custom ? ' data-custom="on"' : ''
          }></div></body></html>`
        )
        await page.addStyleTag({ content: cssContent })
        await page.evaluate(
          ({ custom, field, scrim, scrimMin, boxes }) => {
            const root = document.getElementById('root')
            document.documentElement.style.height = '100%'
            document.body.style.cssText = 'margin:0;height:100%;overflow:hidden'
            if (custom) {
              const bd = document.createElement('div')
              bd.style.cssText = `position:fixed;inset:0;background:rgb(${field},${field},${field});z-index:0`
              root.appendChild(bd)
              root.style.setProperty('--custom-chrome-alpha', String(scrimMin))
              root.style.setProperty('--custom-chrome-scrim', `rgba(${scrim.join(', ')}, ${scrimMin})`)
            }
            for (const box of boxes) {
              if (!box.patch) continue
              const patch = document.createElement('div')
              patch.style.cssText =
                `position:fixed;left:${box.x}px;top:${box.y}px;width:${box.w}px;` +
                `height:${box.h}px;background:var(--raised);z-index:1`
              root.appendChild(patch)
            }
            for (const box of boxes) {
              const el = document.createElement('div')
              el.className = box.cls.join(' ')
              el.setAttribute('data-material', box.name)
              el.style.cssText =
                `position:fixed;left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px;z-index:2`
              root.appendChild(el)
            }
            return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))
          },
          {
            custom: pass.custom,
            field: pass.field,
            scrim,
            scrimMin,
            boxes: [...layouts].flatMap(([name, rects]) =>
              rects.map((r) => ({
                ...r,
                name,
                cls: materials.get(name)
              }))
            )
          }
        )
        const shot = (await page.screenshot({ type: 'png' })).toString('base64')
        const extremes = await page.evaluate(
          ({ png, probes }) =>
            new Promise((done) => {
              const img = new Image()
              img.onload = () => {
                const c = document.createElement('canvas')
                c.width = img.width
                c.height = img.height
                const ctx = c.getContext('2d')
                ctx.drawImage(img, 0, 0)
                const lin = (v) => {
                  const x = v / 255
                  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
                }
                const out = {}
                for (const probe of probes) {
                  let lightest = null
                  let darkest = null
                  for (const r of probe.rects) {
                    if (r.w <= 0 || r.h <= 0) continue
                    const { data } = ctx.getImageData(r.x, r.y, r.w, r.h)
                    for (let i = 0; i < data.length; i += 4) {
                      const px = [data[i], data[i + 1], data[i + 2]]
                      const l = 0.2126 * lin(px[0]) + 0.7152 * lin(px[1]) + 0.0722 * lin(px[2])
                      if (lightest === null || l > lightest.l) lightest = { px, l }
                      if (darkest === null || l < darkest.l) darkest = { px, l }
                    }
                  }
                  if (lightest === null) continue
                  out[probe.name] = {
                    lightest: lightest.px,
                    lightestL: lightest.l,
                    darkest: darkest.px,
                    darkestL: darkest.l
                  }
                }
                done(out)
              },
                (img.src = `data:image/png;base64,${png}`)
            }),
          {
            png: shot,
            probes: [...layouts].map(([name, rects]) => ({
              name,
              rects: rects.map((r) => ({
                x: r.x + BOX_INSET,
                y: r.y + BOX_INSET,
                w: Math.max(0, r.w - BOX_INSET * 2),
                h: Math.max(0, r.h - BOX_INSET * 2)
              }))
            }))
          }
        )
        const fmt = (px) => `rgb(${px[0]}, ${px[1]}, ${px[2]})`
        for (const [name, extreme] of Object.entries(extremes)) {
          const key = pass.key(name)
          const worst = measured[theme][key]
          if (!worst) {
            measured[theme][key] = {
              lightest: fmt(extreme.lightest),
              lightL: extreme.lightestL,
              darkest: fmt(extreme.darkest),
              darkL: extreme.darkestL
            }
            continue
          }
          if (extreme.lightestL > worst.lightL) {
            worst.lightest = fmt(extreme.lightest)
            worst.lightL = extreme.lightestL
          }
          if (extreme.darkestL < worst.darkL) {
            worst.darkest = fmt(extreme.darkest)
            worst.darkL = extreme.darkestL
          }
        }
      }
    }
  } finally {
    await browser.close()
  }

  const errors = [...groundErrors]

  for (const theme of themes) {
    for (const [colorVar] of mappings) {
      const { value } = results[theme][colorVar]
      if (value === '' || value.includes('var(')) {
        errors.push(
          `[resolves] ${colorVar} did not resolve in theme "${theme}": expected a concrete value, got ${JSON.stringify(value)}`
        )
      }
    }
  }

  for (const theme of themes) {
    for (const [colorVar, sourceVar] of mappings) {
      const { value, sourceValue } = results[theme][colorVar]
      if (value !== sourceValue) {
        errors.push(
          `[matches-source] ${colorVar} in theme "${theme}" resolved to ${JSON.stringify(value)} but its source ${sourceVar} resolved to ${JSON.stringify(sourceValue)} in the same scope — expected them to be equal`
        )
      }
    }
  }

  let mostVaryingToken = null
  let mostVaryingDistinctCount = -1
  let mostVaryingValues = null
  for (const [colorVar] of mappings) {
    const values = themes.map((theme) => results[theme][colorVar].value)
    const distinct = new Set(values)
    if (distinct.size > mostVaryingDistinctCount) {
      mostVaryingDistinctCount = distinct.size
      mostVaryingToken = colorVar
      mostVaryingValues = distinct
    }
  }
  if (mostVaryingDistinctCount <= 1) {
    errors.push(
      `[re-resolves-per-scope] no --color-* token varies across themes — the token with the most variety, ${mostVaryingToken}, ` +
        `resolved to the same value in every one of the ${themes.length} themes (${JSON.stringify([...(mostVaryingValues ?? [])])}). ` +
        `Expected at least one theme-varying token to produce more than one distinct value. This means the [data-theme] ` +
        `redeclaration in tailwind.css is missing or broken and every theme is collapsing to whichever one is active on :root.`
    )
  }

  function parseRgb(value) {
    const hex = value.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
    if (hex) {
      const h = hex[1]
      const expand = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
      return {
        r: parseInt(expand.slice(0, 2), 16),
        g: parseInt(expand.slice(2, 4), 16),
        b: parseInt(expand.slice(4, 6), 16)
      }
    }
    const srgb = value.match(/^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/)
    if (srgb) {
      return { r: Number(srgb[1]) * 255, g: Number(srgb[2]) * 255, b: Number(srgb[3]) * 255 }
    }
    const m = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/)
    if (!m) return null
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) }
  }
  function relativeLuminance({ r, g, b }) {
    const linear = (c) => {
      const v = c / 255
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
  }
  function contrastRatio(aValue, bValue) {
    const a = parseRgb(aValue)
    const b = parseRgb(bValue)
    if (!a || !b) return null
    const lA = relativeLuminance(a)
    const lB = relativeLuminance(b)
    const lighter = Math.max(lA, lB)
    const darker = Math.min(lA, lB)
    return (lighter + 0.05) / (darker + 0.05)
  }

  for (const theme of themes) {
    const tokens = legibility[theme]

    const inkGround = contrastRatio(tokens['--text-primary'], tokens['--background'])
    if (inkGround === null) {
      errors.push(
        `[legibility] theme "${theme}": could not parse --text-primary (${JSON.stringify(tokens['--text-primary'])}) or --background (${JSON.stringify(tokens['--background'])}) as rgb()/rgba()`
      )
    } else if (inkGround < 4.5) {
      errors.push(
        `[legibility] theme "${theme}": --text-primary/--background contrast is ${inkGround.toFixed(2)}:1, expected >= 4.5:1 (--text-primary ${tokens['--text-primary']}, --background ${tokens['--background']})`
      )
    }

    for (const against of ['--surface', '--raised']) {
      const ratio = contrastRatio(tokens['--focus-ring'], tokens[against])
      if (ratio === null) {
        errors.push(
          `[legibility] theme "${theme}": could not parse --focus-ring (${JSON.stringify(tokens['--focus-ring'])}) or ${against} (${JSON.stringify(tokens[against])}) as rgb()/rgba()`
        )
      } else if (ratio < 3) {
        errors.push(
          `[legibility] theme "${theme}": --focus-ring/${against} contrast is ${ratio.toFixed(2)}:1, expected >= 3:1 (--focus-ring ${tokens['--focus-ring']}, ${against} ${tokens[against]})`
        )
      }
    }
  }

  function referenceProbe(key) {
    if (key.endsWith('@custom')) return key.slice(0, -'@custom'.length)
    if (key.endsWith('-glass')) return key.slice(0, -'-glass'.length)
    if (key === 'base') return null
    return 'base'
  }

  const probeKeys = []
  const fieldRungs = []
  const TRANSPARENT = /^rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\)$/
  for (const name of MATERIAL_NAMES) {
    probeKeys.push(name)
    const perTheme = themes.map((theme) => ladder[theme])
    const custom = perTheme.map((t) => t[`${name}@custom`].bg)
    if (custom.every((bg) => TRANSPARENT.test(bg))) {
      fieldRungs.push(name)
      continue
    }
    if (perTheme.some((t, i) => custom[i] !== t[name].bg)) probeKeys.push(`${name}@custom`)
  }

  const themeInkIsLight = {}
  for (const theme of themes) {
    const ink = parseRgb(legibility[theme]['--text-primary'])
    const ground = parseRgb(legibility[theme]['--background'])
    themeInkIsLight[theme] =
      ink !== null && ground !== null ? relativeLuminance(ink) > relativeLuminance(ground) : true
  }

  const GROUND_TOLERANCE = 0.002
  for (const theme of themes) {
    const inkIsLight = themeInkIsLight[theme]
    for (const key of probeKeys) {
      const m = measured[theme]?.[key]
      const t = ladder[theme][key]
      if (!m || !t) continue
      const rung = key.replace('@custom', '')
      const receiptName = key.endsWith('@custom') ? `--material-${rung}-custom-worst` : `--material-${rung}-worst`
      const claimed = parseRgb(t.worst)
      if (claimed === null) {
        errors.push(
          `[material-ground] theme "${theme}", rung "${key}": ${receiptName} ` +
            `${JSON.stringify(t.worst)} did not resolve to an rgb() colour.`
        )
        continue
      }
      const claimedL = relativeLuminance(claimed)
      const worstRgb = inkIsLight ? m.lightest : m.darkest
      const worstL = inkIsLight ? m.lightL : m.darkL
      const optimistic = inkIsLight ? claimedL < worstL - GROUND_TOLERANCE : claimedL > worstL + GROUND_TOLERANCE
      if (optimistic) {
        errors.push(
          `[material-ground] theme "${theme}", rung "${key}": its receipt claims ${t.worst} but the shipped ` +
            `recipe actually composites to ${worstRgb}.\n` +
            `  claimed relative luminance ${claimedL.toFixed(4)}, measured ${worstL.toFixed(4)} ` +
            `(${inkIsLight ? 'lightest' : 'darkest'} ground, the one this theme's ink is hurt by)\n` +
            `  recipe ${materials.get(rung).join(' ')}\n` +
            `  measured over the synthetic field (ceiling ${bounds.ceilingMax}, scrim ${bounds.scrimMin})` +
            `${key.endsWith('@custom') ? ', in the [data-custom=\'on\'] scope' : ''}\n` +
            `  The receipt is optimistic, so [material-legibility] below is checking this rung's ink against a ` +
            `ground the browser does not produce. Set it to ${worstRgb}, or change the recipe until the measurement ` +
            `comes back to the claim.`
        )
      }
    }
  }

  const INK_TOLERANCE = 0.02
  for (const theme of themes) {
    for (const key of probeKeys) {
      const refKey = referenceProbe(key)
      if (refKey === null) continue
      const t = ladder[theme][key]
      const ref = ladder[theme][refKey]
      if (!t || !ref) continue
      for (const token of MATERIAL_INK_TOKENS) {
        const refRatio = contrastRatio(ref.ink[token], ref.worst)
        const ratio = contrastRatio(t.ink[token], t.worst)
        if (refRatio === null || ratio === null) {
          errors.push(
            `[material-legibility] theme "${theme}", rung "${key}": could not parse ${token} for a contrast ` +
              `ratio — this rung ${JSON.stringify(t.ink[token])} against its receipt ${JSON.stringify(t.worst)}, ` +
              `reference rung "${refKey}" ${JSON.stringify(ref.ink[token])} against ${JSON.stringify(ref.worst)}. ` +
              `Expected every one of them to resolve to an rgb()/rgba() colour.`
          )
          continue
        }
        const bar = Math.min(4.5, refRatio)
        if (ratio < bar - INK_TOLERANCE) {
          const rung = key.replace('@custom', '')
          errors.push(
            `[material-legibility] theme "${theme}", rung "${key}": ${token} is ${ratio.toFixed(2)}:1, ` +
              `expected >= ${bar.toFixed(2)}:1 — min(4.5, its ${refRatio.toFixed(2)}:1 on "${refKey}", the ground ` +
              `this rung replaces).\n` +
              `  ink    ${t.ink[token]} (theme.css's [data-material='${rung}'] rule, or the theme's own token ` +
              `where that rung declares no cut)\n` +
              `  ground ${t.worst} (--material-${rung}-worst, re-measured above from the shipped recipe)\n` +
              `  Fix by cutting --material-${rung}-${token.replace('--', '')} for this theme, or by changing the ` +
              `rung's ground until the ink it inherits clears.`
          )
        }
      }
    }
  }

  if (errors.length > 0) {
    console.error(`check:css failed with ${errors.length} error(s):\n\n${errors.join('\n')}`)
    process.exit(1)
  }

  console.log(
    `check:css passed — layer order ${effective.join(' < ')}; ` +
      `${mappings.size} --color-* token(s) checked across ${themes.length} theme(s); ` +
      `most-varying token ${mostVaryingToken} produced ${mostVaryingDistinctCount} distinct values; ` +
      `${probeKeys.length} material probe(s) over ${MATERIAL_NAMES.length} rung(s) ` +
      `(${probeKeys.join(', ')}) had their receipts re-measured over the synthetic field at ` +
      `ceiling ${bounds.ceilingMax} / scrim ${bounds.scrimMin}, and ${MATERIAL_INK_TOKENS.length} ink token(s) ` +
      `cleared min(4.5, the ground each rung replaces) on every one` +
      `${fieldRungs.length > 0 ? `; [${fieldRungs.join(', ')}] is the field itself in Custom and carries no ink` : ''}.`
  )
}

main().catch((err) => {
  fail(`check:css crashed: ${err.stack ?? err.message}`)
})
