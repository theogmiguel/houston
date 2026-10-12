import { Chip } from './Chip'
import { CopyChip } from './CopyChip'
import { PaneHeader } from './PaneHeader'
import { PaneStateChip } from './PaneControls'
import { ShellBranchCopyChip } from './ShellPrimitives'
import { TagChip } from './TagChip'
import { PullRequestLabel } from './PullRequestLabel'
import { PullRequestState } from './PullRequestState'
import { PRS_CLASSES } from './PrsClasses'

export function ChipShapeSpecimen(): React.JSX.Element {
  return <div className="grid gap-[var(--space-4)] p-[var(--space-4)]">
    <section><h3>Values</h3><div className="flex items-center gap-[var(--space-2)]"><Chip variant="state" label="Ready" /><Chip variant="count" count={3} /><TagChip tag={{ id: 1, name: 'Bug', color: 'var(--warn)' }} /><PullRequestLabel>bug</PullRequestLabel><span className={PRS_CLASSES.PRS_CLASS_15}>PR list label</span><PullRequestState state="open">Open</PullRequestState></div></section>
    <section><h3>Actions</h3><div className="flex items-center gap-[var(--space-2)]"><Chip variant="choice" label="Selected choice" selected onClick={() => {}} /><Chip variant="choice" label="Other choice" onClick={() => {}} /><Chip variant="choice" label="Disabled choice" disabled onClick={() => {}} /><CopyChip value="gh pr checkout 95">gh pr checkout 95</CopyChip><TagChip tag={{ id: 2, name: 'Filter tag', color: 'var(--warn)' }} onToggle={() => {}} /><button type="button" className={PRS_CLASSES.PRS_CLASS_38}>Filters <span className={PRS_CLASSES.PRS_CLASS_44}>1</span></button></div></section>
    <section><h3>Pane header</h3><PaneHeader><span className="min-w-0 flex-1 truncate">Terminal</span><ShellBranchCopyChip value="feature/ui">feature/ui</ShellBranchCopyChip><TagChip tag={{ id: 1, name: 'Bug', color: 'var(--warn)' }} /><PaneStateChip state="exited">Exited</PaneStateChip></PaneHeader></section>
  </div>
}
