// @vitest-environment node
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { expect, it } from 'vitest'

it('fully collapses the description and hides its edit action on hover and keyboard focus', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'houston-pr-vite-'))
  const server = await createServer({
    cacheDir,
    configFile: fileURLToPath(new URL('../../../../../vite.config.ts', import.meta.url)),
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, watch: null }
  })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer!.address() as { port: number }
    browser = await chromium.launch({ channel: 'chrome' })
    const page = await browser.newPage({ viewport: { width: 732, height: 800 } })
    page.on('pageerror', error => console.error(error))
    for (const width of [470, 732]) {
      await page.goto(`http://127.0.0.1:${address.port}/harness/index.html?story=prs/detail-draft-${width}&theme=graphite`)
      const toggle = page.getByRole('button', { name: 'Description', exact: true })
      const description = page.getByTestId('pr-description')
      const fold = toggle.locator('xpath=ancestor::*[@data-testid="disclosure"]').locator(':scope > div').last()
      await toggle.click()
      await toggle.hover()
      await page.evaluate(() => {
        document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).forEach(animation => animation.finish())
      })
      expect((await fold.boundingBox())!.height).toBe(0)
      expect(await description.getByRole('button', { name: 'Edit title and description', exact: true }).count()).toBe(0)
      await toggle.focus()
      await page.keyboard.press('Tab')
      expect(await description.evaluate(node => node.contains(document.activeElement))).toBe(false)
      await toggle.click()
      await toggle.hover()
      await description.getByTestId('pr-edit-open').click()
      await description.getByLabel('Pull request title').fill('Updated title')
      await toggle.click()
      await toggle.click()
      expect(await description.getByLabel('Pull request title').inputValue()).toBe('Updated title')
    }
  } finally {
    await browser?.close()
    await server.close()
    rmSync(cacheDir, { recursive: true, force: true })
  }
}, 90_000)
