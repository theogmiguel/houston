import { isAbsolute, relative } from 'node:path'
import type { Plugin } from 'vite'

export interface BundleChunkStats {
  fileName: string
  bytes: number
  isEntry: boolean
  facade: string | null
  imports: string[]
  dynamicImports: string[]
  packages: string[]
  appModules: string[]
}

export interface BundleStats {
  entry: string
  chunks: BundleChunkStats[]
}

export const STATS_FILE_NAME = 'bundle-stats.json'

export function packageNameFromModuleId(id: string): string | null {
  const cleaned = id.replace(/^\0/, '')
  const marker = 'node_modules/'
  const at = cleaned.lastIndexOf(marker)
  if (at === -1) return null
  const rest = cleaned.slice(at + marker.length)
  const parts = rest.split('/')
  if (parts[0]?.startsWith('@')) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null
  }
  return parts[0] || null
}

export function appModulePathFromModuleId(id: string, cwd: string): string | null {
  if (id.startsWith('\0') || id.includes('\0')) return null
  const path = id.split('?')[0]
  if (path === '') return null
  const posix = path.replaceAll('\\', '/')
  if (posix.includes('node_modules/')) return null
  if (!isAbsolute(posix)) return null
  return relative(cwd, posix).replaceAll('\\', '/')
}

export function bundleStats(): Plugin {
  return {
    name: 'tr-bundle-stats',
    apply: 'build',
    generateBundle(_options, bundle) {
      const chunks: BundleChunkStats[] = []
      let entry: string | null = null
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== 'chunk') continue
        const packages = new Set<string>()
        const appModules = new Set<string>()
        for (const id of Object.keys(output.modules)) {
          const pkg = packageNameFromModuleId(id)
          if (pkg) {
            packages.add(pkg)
            continue
          }
          const appPath = appModulePathFromModuleId(id, process.cwd())
          if (appPath) appModules.add(appPath)
        }
        if (output.isEntry) entry = fileName
        chunks.push({
          fileName,
          bytes: Buffer.byteLength(output.code, 'utf8'),
          isEntry: output.isEntry,
          facade: output.facadeModuleId,
          imports: [...output.imports],
          dynamicImports: [...output.dynamicImports],
          packages: [...packages].sort(),
          appModules: [...appModules].sort()
        })
      }
      if (entry === null) {
        throw new Error(
          `tr-bundle-stats: no entry chunk in the bundle (${chunks.length} chunks seen) — ` +
            `expected exactly one chunk with isEntry: true`
        )
      }
      chunks.sort((a, b) => a.fileName.localeCompare(b.fileName))
      const stats: BundleStats = { entry, chunks }
      this.emitFile({
        type: 'asset',
        fileName: STATS_FILE_NAME,
        source: JSON.stringify(stats, null, 2) + '\n'
      })
    }
  }
}
