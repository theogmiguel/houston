import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import pkg from '../package.json' with { type: 'json' }
export default defineConfig({
  root: __dirname,
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true },
  // Anchor every alias regex: the alias plugin replaces only the matched
  // SUBSTRING, so an unanchored suffix match splices the absolute replacement
  // into the tail of a relative specifier instead of replacing it.
  resolve: {
    alias: [
      {
        find: /^(?:\.\.\/)+(?:src\/renderer\/src\/)?pane\/TerminalPane$/,
        replacement: fileURLToPath(new URL('./StubTerminalPane.tsx', import.meta.url))
      },
      {
        find: /^(?:\.\/|(?:\.\.\/)+(?:src\/renderer\/src\/)?)houston\/client$/,
        replacement: fileURLToPath(new URL('./StubHoustonClient.ts', import.meta.url))
      }
    ]
  }
})
