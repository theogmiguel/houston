import {
  IconDatabase,
  IconFile,
  IconFileArchive,
  IconFileAxis3d,
  IconFileBox,
  IconFileBraces,
  IconFileChartColumn,
  IconFileCode,
  IconFileCog,
  IconFileDiff,
  IconFileImage,
  IconFileJson,
  IconFileKey,
  IconFileLock,
  IconFileMusic,
  IconFileSliders,
  IconFileSpreadsheet,
  IconFileTerminal,
  IconFileText,
  IconFileType,
  IconFileVideoCamera,
  type IconComponent
} from '../icons'

// Glyphs are chosen from the name alone, so a remote or SSH workspace without OS file
// associations shows the same icons as a local one.
const BY_EXTENSION = group([
  [IconFileCode, 'ts tsx mts cts js jsx mjs cjs rb rs py go java kt kts swift c h cc cpp cxx hpp hh cs fs php lua pl r scala clj ex exs erl hs ml dart zig nim vue svelte astro html htm xml xsl css scss sass less styl graphql gql proto sol wasm erb haml slim'],
  [IconFileTerminal, 'sh bash zsh fish ps1 psm1 bat cmd'],
  [IconFileJson, 'json jsonc json5 geojson webmanifest'],
  [IconFileBraces, 'jsonl ndjson'],
  [IconFileSliders, 'yml yaml toml ini cfg conf properties'],
  [IconFileText, 'md mdx markdown txt text rst adoc org rtf tex log'],
  [IconFileType, 'ttf otf woff woff2 eot'],
  [IconFileImage, 'png jpg jpeg gif webp avif bmp ico svg tif tiff heic psd ai'],
  [IconFileVideoCamera, 'mp4 mov webm mkv avi m4v'],
  [IconFileMusic, 'mp3 wav ogg flac m4a aac'],
  [IconFileArchive, 'zip tar gz tgz bz2 xz 7z rar zst jar war tar.gz tar.bz2 tar.xz'],
  [IconFileSpreadsheet, 'csv tsv xls xlsx ods'],
  [IconFileChartColumn, 'ipynb'],
  [IconDatabase, 'sql sqlite sqlite3 db prisma'],
  [IconFileKey, 'pem key crt cer csr pub asc gpg'],
  [IconFileLock, 'lock lockb'],
  [IconFileDiff, 'diff patch'],
  [IconFileAxis3d, 'obj stl fbx gltf glb blend']
])

const BY_NAME = group([
  [IconFileBox, 'package.json cargo.toml go.mod pyproject.toml gemfile composer.json deno.json pubspec.yaml'],
  [IconFileLock, 'package-lock.json yarn.lock pnpm-lock.yaml bun.lock bun.lockb cargo.lock go.sum gemfile.lock poetry.lock composer.lock'],
  [IconFileCog, 'makefile rakefile procfile justfile cmakelists.txt docker-compose.yml docker-compose.yaml compose.yml compose.yaml'],
  [IconFileSliders, '.editorconfig .gitignore .gitattributes .dockerignore .npmrc .nvmrc .prettierrc .eslintrc .babelrc .browserslistrc .rubocop.yml .tool-versions'],
  [IconFileKey, 'codeowners'],
  [IconFileText, 'license licence readme changelog authors contributing']
])

function group(entries: ReadonlyArray<readonly [IconComponent, string]>): ReadonlyMap<string, IconComponent> {
  const map = new Map<string, IconComponent>()
  for (const [glyph, keys] of entries) for (const key of keys.split(' ')) map.set(key, glyph)
  return map
}

function extensionGlyph(name: string): IconComponent | undefined {
  // Longest suffix first, so `tar.gz` wins over `gz`.
  for (let dot = name.indexOf('.', 1); dot !== -1; dot = name.indexOf('.', dot + 1)) {
    const glyph = BY_EXTENSION.get(name.slice(dot + 1))
    if (glyph) return glyph
  }
  return undefined
}

export function fileTypeIcon(path: string): IconComponent {
  const name = (path.split(/[\\/]/).at(-1) ?? '').toLowerCase()
  const stem = name.replace(/\.(md|txt)$/, '')
  return (
    BY_NAME.get(name) ??
    BY_NAME.get(stem) ??
    (name === '.env' || name.startsWith('.env.') ? IconFileLock : undefined) ??
    (name === 'dockerfile' || name.startsWith('dockerfile.') || name.endsWith('.dockerfile') ? IconFileCog : undefined) ??
    extensionGlyph(name) ??
    IconFile
  )
}
