// @vitest-environment node
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import { expect, it } from 'vitest'

it('keeps animated artwork from intercepting rail buttons while preserving mascot dragging', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'houston-mascot-vite-'))
  const server = await createServer({
    cacheDir,
    configFile: fileURLToPath(new URL('../../../../vite.config.ts', import.meta.url)),
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, watch: null }
  })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer!.address() as { port: number }
    browser = await chromium.launch({ channel: 'chrome' })
    const page = await browser.newPage({ viewport: { width: 400, height: 240 } })
    page.on('pageerror', error => console.error(error))
    await page.goto(`http://127.0.0.1:${address.port}/harness/index.html?story=mascot&mode=live&theme=graphite`)
    await page.getByTestId('mascot-companion').waitFor()
    await page.evaluate(() => {
      Math.random = () => 0
      window.dispatchEvent(new CustomEvent('houston-mascot-action', { detail: 'hi' }))
    })
    await page.locator('.mascot-rig.a-wave').waitFor()
    // Freeze a real greeting pose whose transparent arm layers extend over the footer.
    await page.evaluate(() => {
      document.getAnimations().forEach(animation => { animation.pause(); animation.currentTime = 1000 })
    })
    const blocked = await page.evaluate(() => {
      const misses: string[] = []
      document.querySelectorAll<HTMLButtonElement>('.railfoot button').forEach(button => {
        const box = button.getBoundingClientRect()
        for (let x = box.left + 2; x < box.right; x += 4) {
          for (let y = box.top + 2; y < box.bottom; y += 4) {
            if (document.elementFromPoint(x, y)?.closest('button') !== button) misses.push(`${button.ariaLabel} at ${x},${y}`)
          }
        }
      })
      return misses
    })
    expect(blocked).toEqual([])
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('.railfoot button').forEach(button => {
        button.addEventListener('click', () => { button.dataset.clicked = 'true' })
      })
    })
    for (const label of ['Settings', 'Pull requests', 'Usage', 'Switch theme']) {
      const button = page.getByRole('button', { name: label, exact: true })
      await button.click({ timeout: 2000 })
      expect(await button.getAttribute('data-clicked')).toBe('true')
    }
    const mascot = page.getByTestId('mascot-companion')
    const box = (await mascot.boundingBox())!
    await page.mouse.move(box.x + 32, box.y + 32)
    await page.mouse.down()
    await page.mouse.move(300, 80, { steps: 5 })
    await page.mouse.up()
    expect(await page.locator('.mascot-host').getAttribute('data-floating')).toBe('true')
    const floating = (await mascot.boundingBox())!
    expect(floating.x).toBeCloseTo(268)
    expect(floating.y).toBeCloseTo(48)
  } finally {
    await browser?.close()
    await server.close()
    rmSync(cacheDir, { recursive: true, force: true })
  }
}, 90_000)
