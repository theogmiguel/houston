/// <reference types="vite/client" />
declare global {
  const __APP_VERSION__: string
}

export interface HoustonConfig {
  port: number
  token: string
  pid: number
  protocol: number
}

export interface Skill {
  agent: 'claude' | 'codex' | 'antigravity'
  name: string
  description: string
  invoke: string
  source: 'user' | 'project'
  path: string
}

export type WriteSkillResult = { ok: true } | { ok: false; error: string }

export interface DirEntry {
  name: string
  path: string
  dir: boolean
  ignored: boolean
}

declare global {
  interface Window {
    houston: {
      getConfig(): Promise<HoustonConfig>
      pickDirectory(): Promise<string | null>
      windowControl(action: 'close' | 'minimize' | 'maximize' | 'focus'): void
      isFocused(): Promise<boolean>
      setZoomFactor(factor: number): void
      saveImage(bytes: Uint8Array, ext: string): Promise<string>
      saveReview(text: string): Promise<string>
      openExternal(url: string): void
      listSkills(projectDir: string | null): Promise<Skill[]>
      writeSkill(
        provider: 'claude' | 'codex' | 'antigravity',
        name: string,
        content: string,
        projectDir: string | null
      ): Promise<WriteSkillResult>
      deleteSkill(path: string): Promise<WriteSkillResult>
      readDir(dir: string): Promise<DirEntry[]>
      readFile(path: string): Promise<string>
      writeFile(path: string, content: string): Promise<void>
      statFile(path: string): Promise<{ mtimeMs: number } | null>
      pathKind(path: string): Promise<'file' | 'dir' | null>
      pickerListDirs(path: string): Promise<string[] | null>
      homeDir(): Promise<string>
      pickFile(defaultPath: string): Promise<string | null>
      getPathForFile(file: File): string
      openPath(path: string): Promise<{ ok: true } | { ok: false; error: string }>
      listShells(): Promise<Array<{ name: string; path: string }>>
      getLogsDir(): Promise<string>
      setBackgroundColor(hex: string): void
      setAllowedRoots(roots: string[]): void
    }
  }

  namespace React {
    namespace JSX {
      interface IntrinsicElements {
        webview: React.DetailedHTMLProps<
          React.HTMLAttributes<HTMLElement> & { src?: string },
          HTMLElement
        >
      }
    }
  }
}

export {}
