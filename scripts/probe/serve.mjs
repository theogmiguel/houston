import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8'
}

export const SHIM_PATH = '/probe-host-shim.js'

function shimSource(config) {
  return `// The one host call the renderer makes before its socket is open.
window.houston = {
  getConfig: () => Promise.resolve(${JSON.stringify(config)})
}
`
}

function withShim(html) {
  const at = html.indexOf('<script type="module"')
  if (at < 0) {
    throw new Error(
      `no <script type="module"> in the built index.html — the renderer build shape changed; ` +
        `expected vite's module entry so the host shim can be put in front of it`
    )
  }
  return html.slice(0, at) + `<script src=".${SHIM_PATH}"></script>\n    ` + html.slice(at)
}

export async function startStaticServer({ root, port, config }) {
  const base = resolve(root)
  const index = join(base, 'index.html')
  try {
    await stat(index)
  } catch {
    throw new Error(
      `no index.html under ${base} — build the renderer first (cd ui && bun run build)`
    )
  }
  const shim = shimSource(config)

  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0])
    if (path === SHIM_PATH) {
      res.writeHead(200, { 'content-type': TYPES['.js'] })
      res.end(shim)
      return
    }
    if (path === '/' || path === '/index.html') {
      readFile(index, 'utf8')
        .then((html) => {
          res.writeHead(200, { 'content-type': TYPES['.html'] })
          res.end(withShim(html))
        })
        .catch((e) => {
          res.writeHead(500, { 'content-type': 'text/plain' })
          res.end(String(e))
        })
      return
    }
    const file = join(base, normalize(path).replace(/^(\.\.[/\\])+/, ''))
    if (!file.startsWith(base + sep)) {
      res.writeHead(403, { 'content-type': 'text/plain' })
      res.end('outside the served root')
      return
    }
    stat(file)
      .then((s) => {
        if (!s.isFile()) throw new Error('not a file')
        res.writeHead(200, {
          'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
          'content-length': s.size
        })
        createReadStream(file).pipe(res)
      })
      .catch(() => {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end(`no ${path} under ${base}`)
      })
  })

  await new Promise((ok, fail) => {
    server.once('error', fail)
    server.listen(port, '127.0.0.1', ok)
  })
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((ok) => server.close(ok))
  }
}
