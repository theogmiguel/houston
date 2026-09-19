import { chromium } from 'playwright'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// WHY A BROWSER: the masters use gradients and feGaussianBlur, which
// ImageMagick's fallback parser drops silently, producing a plausible-looking
// wrong icon. Playwright rasterises with the engine the app itself ships on.

const here = dirname(fileURLToPath(import.meta.url))
const resources = join(here, '..', 'resources')

// 48 is the largest standard size where the thin small cut still reads as the
// same object: its 3.2-unit front edge is one device pixel at 160px and a
// quarter of one at 40px.
const SMALL_AT = 48

const SIZES = [16, 22, 24, 32, 48, 64, 128, 256, 512]

const TAURI_ALIASES = [
  [32, '32x32.png'],
  [128, '128x128.png'],
  [256, '128x128@2x.png'],
  [512, 'icon.png']
]

const ICO_SIZES = [16, 24, 32, 48, 64, 256]

const trayOut = join(here, '..', '..', 'src-tauri', 'icons', 'tray')
const bundleOut = join(here, '..', '..', 'src-tauri', 'icons')

const TRAY_SIZES = [16, 20, 22, 24, 32, 40, 44, 48]

const WARN = '#f59e0b'

function trayState(master, state) {
  const inner = master.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
  const svg = (body) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">${body}</svg>`
  if (state === 'idle') return svg(`<g opacity="0.55">${inner}</g>`)
  if (state === 'active') return svg(inner)
  return svg(
    `<defs><mask id="tray-badge" maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">` +
      `<rect width="16" height="16" fill="#fff" />` +
      `<circle cx="12.8" cy="12.8" r="3.9" fill="#000" />` +
      `</mask></defs>` +
      `<g mask="url(#tray-badge)">${inner}</g>` +
      `<circle cx="12.8" cy="12.8" r="2.9" fill="${WARN}" />`
  )
}

async function main() {
  const detail = await readFile(join(resources, 'icon.svg'), 'utf8')
  const small = await readFile(join(resources, 'icon-small.svg'), 'utf8')

  const browser = await chromium.launch()
  try {
    const written = []
    const icoPngs = new Map()
    for (const size of SIZES) {
      const svg = size <= SMALL_AT ? small : detail
      const png = await rasterise(browser, svg, size)
      const out = join(resources, 'icons', 'hicolor', `${size}x${size}.png`)
      await mkdir(dirname(out), { recursive: true })
      await writeFile(out, png)
      written.push([size, out, size <= SMALL_AT ? 'small' : 'detail'])

      if (ICO_SIZES.includes(size)) icoPngs.set(size, png)

      for (const [aliasSize, aliasName] of TAURI_ALIASES) {
        if (aliasSize !== size) continue
        await mkdir(bundleOut, { recursive: true })
        await writeFile(join(bundleOut, aliasName), png)
      }
    }

    const master = await rasterise(browser, detail, 512)
    await writeFile(join(resources, 'icon.png'), master)

    await writeFile(
      join(bundleOut, 'icon.ico'),
      buildIco(ICO_SIZES.map((size) => [size, icoPngs.get(size)]))
    )

    const tray = await readFile(join(resources, 'icon-tray.svg'), 'utf8')
    await mkdir(trayOut, { recursive: true })
    const trayWritten = []
    for (const state of ['idle', 'active', 'attention']) {
      const svg = trayState(tray, state)
      for (const size of TRAY_SIZES) {
        const out = join(trayOut, `${state}-${size}.png`)
        await writeFile(out, await rasterise(browser, svg, size))
        trayWritten.push([state, size])
      }
    }

    for (const [size, out, cut] of written) {
      console.log(`  ${String(size).padStart(3)}px  ${cut.padEnd(6)}  ${out.replace(resources + '/', '')}`)
    }
    console.log(`  512px  detail  icon.png`)
    console.log(
      `  bundle 4 aliases + icon.ico  src-tauri/icons/{${TAURI_ALIASES.map(([, n]) => n).join(',')},icon.ico}`
    )
    console.log(
      `  tray   ${trayWritten.length} cuts  src-tauri/icons/tray/{idle,active,attention}-{${TRAY_SIZES.join(',')}}.png`
    )
  } finally {
    await browser.close()
  }
}

async function rasterise(browser, svg, size) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1
  })
  try {
    await page.setContent(
      `<!doctype html><meta charset="utf-8">` +
        `<style>html,body{margin:0;padding:0;background:transparent}` +
        `svg{display:block;width:${size}px;height:${size}px}</style>` +
        svg,
      { waitUntil: 'load' }
    )
    return await page.screenshot({ omitBackground: true, type: 'png' })
  } finally {
    await page.close()
  }
}

function buildIco(entries) {
  const count = entries.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(count, 4)

  const dir = Buffer.alloc(16 * count)
  let offset = 6 + 16 * count
  const blobs = []
  entries.forEach(([size, png], i) => {
    const entry = dir.subarray(i * 16, i * 16 + 16)
    entry.writeUInt8(size === 256 ? 0 : size, 0)
    entry.writeUInt8(size === 256 ? 0 : size, 1)
    entry.writeUInt8(0, 2)
    entry.writeUInt8(0, 3)
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(png.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += png.length
    blobs.push(png)
  })

  return Buffer.concat([header, dir, ...blobs])
}

await main()
