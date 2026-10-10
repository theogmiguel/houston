/** Read-only view of one pane for the bench harness (src-tauri/src/bench_harness.js),
 * which checks content and repaint cost after a hidden pane is revealed. */
export interface BenchPaneProbe {
  /** Visible rows with soft-wrapped rows joined back into their logical line. */
  screenText(): string
  size(): { cols: number; rows: number }
  /** Sends text the way typed input reaches the session. */
  sendInput(text: string): void
  focus(): void
  hasFocus(): boolean
  fullText(): string
  paintCount(): number
  synced(): boolean
  attached(): boolean
}

type ProbeMap = Map<number, BenchPaneProbe>

/** No-op unless the harness installed `__trBenchProbes__`, so ordinary runs keep no
 * references to disposed panes. */
export function registerBenchProbe(session: number, probe: BenchPaneProbe): () => void {
  const probes = (globalThis as { __trBenchProbes__?: ProbeMap }).__trBenchProbes__
  if (!(probes instanceof Map)) return () => {}
  probes.set(session, probe)
  return () => {
    if (probes.get(session) === probe) probes.delete(session)
  }
}
