import React, { useState } from 'react'
import { InspectorHeader } from '../src/components/ui/InspectorHeader'
import { IconAgent } from '../src/components/icons'

type Theme = 'graphite' | 'paper'
type Board = 'changes' | 'pr' | 'children'

const panes = [
  { title: 'orchestrator', body: 'pane_spawn(codex, role: "batch-wakes")\n⎿ Spawned 1009 · wt/batch-wakes\n\npane_wait(kind: result)\n⎿ integration-test exited 1 · batch-wakes needs input' },
  { title: 'inbox-api', body: '• Edited core/houston-core/src/orchestrate.rs (+52 −12)\n• Ran cargo test -p houston-core --test inbox_api_wire\n  └ running 4 tests …' },
  { title: 'shell', body: '$ git log --oneline -3\na1c3f09 Add the batch wake fixture\n7d20e44 Read inbox rows per parent' }
]

function Frame({ theme, board }: { theme: Theme; board: Board }): React.JSX.Element {
  const [tab, setTab] = useState(board === 'pr' ? 'pull-request' : 'changes')
  const closed = board === 'children'
  React.useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  const inspectorWidth = 384
  return <div style={{ display: 'flex', width: '100%', height: '100%', color: 'var(--text-primary)', background: 'var(--content-bg)', font: '12px var(--font-sans)' }}>
    <aside style={{ width: 240, flex: 'none', display: 'grid', gridTemplateRows: 'auto 1fr auto', background: 'var(--rail-bg)', borderRight: '1px solid var(--divider)' }}>
      <div style={{ padding: '12px', fontWeight: 650 }}>Houston</div>
      <div style={{ padding: '8px', display: 'grid', alignContent: 'start', gap: 4 }}>
        {['Tasks', 'Skills', 'Routines', 'Harness', 'Connections', 'Usage', 'Workspaces', 'dispatch', 'Flow Builder', 'Improve Orchestration', 'Tasks backlog'].map((name, index) => <div key={name} style={{ padding: '5px 8px', borderRadius: 5, background: name === 'Improve Orchestration' ? 'var(--selected-fill)' : 'transparent', color: index < 6 ? 'var(--text-secondary)' : 'var(--text-primary)' }}>{name}</div>)}
      </div>
      <div style={{ padding: 12, borderTop: '1px solid var(--divider)', color: 'var(--text-muted)' }}>Settings　◐</div>
    </aside>
    <div style={{ display: 'flex', flex: 1, minWidth: 0, flexDirection: 'column' }}>
      <header style={{ height: 34, flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px', borderBottom: '1px solid var(--divider)' }}>
        <button className="btn" aria-label="Tidy panes">▦</button><button className="btn" aria-label="Hide side panel">▤</button><span style={{ flex: 1 }} /><span style={{ color: 'var(--text-muted)' }}>−　□　×</span>
      </header>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <main style={{ flex: 1, minWidth: 0, display: 'grid', gridTemplateColumns: '1.05fr 1fr', gridTemplateRows: '1.3fr 1fr', gap: 6, padding: 8 }}>
          {panes.map((pane, index) => <section key={pane.title} style={{ gridRow: index === 0 ? '1 / 3' : undefined, display: 'flex', minWidth: 0, minHeight: 0, flexDirection: 'column', overflow: 'hidden', border: `1px solid ${index === (board === 'pr' ? 0 : 1) ? 'var(--border-focus)' : 'var(--border)'}`, borderRadius: 7, background: 'var(--pane-bg)' }}>
            <div style={{ height: 28, flex: 'none', display: 'flex', alignItems: 'center', padding: '0 8px', borderBottom: '1px solid var(--divider)', background: 'var(--pane-head)' }}><IconAgent brand agent={index === 0 ? 'claude' : 'codex'} /><strong style={{ marginLeft: 7 }}>{board === 'pr' && index === 0 ? 'orchestrator' : pane.title}</strong><span style={{ marginLeft: 'auto', color: 'var(--text-muted)' }}>⌘　＋　×</span></div>
            {index === 0 && board === 'children' ? <div style={{ display: 'flex', flex: 1, minHeight: 0 }}><div style={{ width: 40, borderRight: '1px solid var(--divider)', background: 'var(--rail-bg)' }}>　✳<br />　◇<br />　✳</div><div style={{ width: 230, padding: 10, borderRight: '1px solid var(--divider)' }}><strong>Children　2　　 Queue　1</strong><p>Orchestrator　pane 1008</p><p style={{ color: 'var(--warn)' }}>Needs you　1</p><article style={{ padding: 10, border: '1px solid var(--border)', borderRadius: 7 }}>batch-wakes　HOU-19<p>Batch wakes per parent</p></article><p>Settled　1</p><article style={{ padding: 10, border: '1px solid var(--border)', borderRadius: 7 }}>integration-test　HOU-21</article><button className="btn">Close settled (1)</button> <button className="btn">Overview</button></div><pre style={{ flex: 1, padding: 12, color: 'var(--text-secondary)' }}>• Edited core/houston-core/src/orchestrate.rs (+52 −12){'\n'}• Ran cargo test — 6 passed{'\n\n'}? Keep the old wake API for one release?{'\n'}› 2. No, remove it now</pre></div> : <pre style={{ flex: 1, margin: 0, padding: 12, overflow: 'hidden', color: 'var(--text-secondary)', font: '11px/1.7 var(--font-mono)' }}>{pane.body}</pre>}
          </section>)}
        </main>
        {!closed && <aside className="pane-inspector" aria-label="Inspector" style={{ width: inspectorWidth }}>
          <InspectorHeader tabs={[{ id: 'changes', label: 'Changes', count: 2 }, { id: 'pull-request', label: 'PR', count: board === 'pr' ? 412 : undefined }, { id: 'files', label: 'Files' }]} active={tab} onSelect={setTab} icon={<IconAgent brand agent={board === 'pr' ? 'claude' : 'codex'} />} title={board === 'pr' ? 'orchestrator' : 'inbox-api'} checkout="wt/inbox-api" ahead={4} branch="feat/tasks-backlog" />
          {tab === 'pull-request' || board === 'pr' ? <section style={{ overflow: 'auto', padding: 12 }}><div style={{ color: 'var(--ok)', fontWeight: 650 }}>Open　#412</div><h3>Batch wake requests per parent</h3><div style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>feat/tasks-backlog → main · 3 commits · +402 −52</div><article style={{ marginTop: 12, padding: 10, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--card-bg)' }}>Watching #412<button className="btn" style={{ float: 'right' }}>Stop watching</button></article><h4>Checks　2 passed · 1 running</h4>{['lint · 38s', 'tests · 2m 14s', 'windows · running'].map((line) => <div key={line} style={{ padding: 7, borderBottom: '1px solid var(--divider)' }}>●　{line}</div>)}<h4>Reviews</h4><article style={{ padding: 10, border: '1px solid var(--border)', borderRadius: 8 }}>alice　Approved<p>Looks good; the retry is bounded.</p><button className="btn">Send to orchestrator</button></article><div style={{ marginTop: 12 }}><button className="btn" disabled>Merge　Checks must pass first</button></div></section> : tab === 'files' ? <section style={{ padding: 12 }}>Files<br /><div style={{ marginTop: 12, color: 'var(--text-secondary)' }}>core/houston-core/src/orchestrate.rs<br />core/houston-core/tests/batch_wake_wire.rs</div></section> : <section style={{ flex: 1, padding: 12, display: 'flex', flexDirection: 'column' }}><div style={{ fontSize: 11, color: 'var(--text-muted)', paddingBottom: 8 }}>UNCOMMITTED · 2 FILES <span style={{ float: 'right' }}>+64　−12</span></div><div style={{ padding: 7, background: 'var(--selected-fill)' }}>M　orchestrate.rs　+52　−12</div><div style={{ padding: 7 }}>A　batch_wake_wire.rs　+12</div><div style={{ marginTop: 8, border: '1px solid var(--border)', borderRadius: 7, overflow: 'hidden', font: '10.5px/1.6 var(--font-mono)' }}><div style={{ padding: 7, color: 'var(--info)', background: 'var(--pane-head)' }}>@@ -208,9 +208,12 @@ impl Daemon &#123;</div><div style={{ padding: 2 }}>208　208　pub fn wake_batch(&amp;self, rows: &amp;[InboxRow])</div><div style={{ padding: 2, background: 'var(--del-bg)', color: 'var(--stop)' }}>209　　　　- for row in rows &#123;</div><div style={{ padding: 2, background: 'var(--add-bg)', color: 'var(--ok)' }}>　209　+ let grouped = group_by_parent(rows);</div></div><div style={{ marginTop: 'auto', paddingTop: 10, borderTop: '1px solid var(--divider)' }}><div style={{ padding: 10, border: '1px solid var(--border)', borderRadius: 7, background: 'var(--content-bg)' }}>Wake each parent once per batch of inbox rows</div><p><button className="btn" style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}>Commit 2 files</button> <button className="btn">Push ↑4</button><small style={{ float: 'right', color: 'var(--text-muted)' }}>to wt/inbox-api</small></p></div></section>}
        </aside>}
      </div>
    </div>
  </div>
}

export const InspectorChangesGraphite = (): React.JSX.Element => <Frame theme="graphite" board="changes" />
export const InspectorChangesPaper = (): React.JSX.Element => <Frame theme="paper" board="changes" />
export const InspectorPrGraphite = (): React.JSX.Element => <Frame theme="graphite" board="pr" />
export const InspectorPrPaper = (): React.JSX.Element => <Frame theme="paper" board="pr" />
export const InspectorChildrenGraphite = (): React.JSX.Element => <Frame theme="graphite" board="children" />
export const InspectorChildrenPaper = (): React.JSX.Element => <Frame theme="paper" board="children" />
