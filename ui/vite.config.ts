import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import pkg from './package.json' with { type: 'json' }
import { bundleStats } from './vite-bundle-stats'

function dropWoffFallback(): Plugin {
  return {
    name: 'drop-fontsource-woff-fallback',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('.css')) return null
      const stripped = code.replace(/,\s*url\([^)]+\.woff\)\s*format\(['"]woff['"]\)/g, '')
      return stripped === code ? null : { code: stripped, map: null }
    }
  }
}

export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),

  base: './',

  plugins: [dropWoffFallback(), react(), tailwindcss(), bundleStats()],

  build: {
    outDir: fileURLToPath(new URL('./out/renderer', import.meta.url)),
    emptyOutDir: true,

    minify: true,

    modulePreload: { polyfill: false },
    assetsInlineLimit: 0
  },

  define: {
    __APP_VERSION__: JSON.stringify(pkg.version)
  }
})
