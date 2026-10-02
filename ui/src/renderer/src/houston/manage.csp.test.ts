// @vitest-environment node
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'

it('allows management HTTP on a separate loopback port under the shipped CSP', async () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
  const policy = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)![1]!
  let requests = 0
  const server = createServer((req, res) => {
    if (req.url === '/manage') {
      requests += 1
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.end('management reached')
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(`<!doctype html><head><meta http-equiv="Content-Security-Policy" content="${policy}"></head>`)
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    browser = await chromium.launch({ channel: 'chrome' })
    const page = await browser.newPage()
    await page.goto(`http://localhost:${address.port}`)
    const result = await page.evaluate(async (url) => (await fetch(url)).text(),
      `http://127.0.0.1:${address.port}/manage`)
    expect(result).toBe('management reached')
    expect(requests).toBe(1)
  } finally {
    await browser?.close()
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
  }
}, 30_000)
