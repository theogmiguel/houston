import { PRS_CLASSES } from '../src/components/ui/PrsClasses'
import { PrTab, PR_FLOATING_MENU, PR_FLOATING_CANDIDATES } from '../src/components/ui/PrTab'
import { Icon } from '../src/components/ui/Icon'
import { IconCheck, IconClose, IconMessageSquare } from '../src/components/icons'
import { ReviewDiffLine } from '../src/components/ui/ReviewDiffLine'

export function UiRoleSpecimenPrs(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <div className={PRS_CLASSES.PRS_PR_ROW}>Pull request row</div>
      <div className={PRS_CLASSES.PRS_CHECK_ROW}>Check row</div>
      <div className={PR_FLOATING_MENU}>Pull request menu</div>
      <div className={PR_FLOATING_CANDIDATES}>Picker candidates</div>
      <div className={PRS_CLASSES.PRS_DETAIL_CONTENT}>Pull request detail content</div>
      <span className={PRS_CLASSES.PRS_STATE_MERGED_ICON}>Merged state icon</span>
      <span className={PRS_CLASSES.PRS_STATE_CLOSED_ICON}>Closed state icon</span>
      <PrTab as="div" surface="pr-check-popover"><PrTab as="div" surface="pr-check-popover-title">All checks have passed</PrTab><PrTab as="div" surface="pr-check-popover-subtitle">4 passed</PrTab></PrTab>
      <PrTab as="div" surface="pr-viewed-notice">Viewing another pull request</PrTab>
      <PrTab as="span" surface="pr-timeline-sha">a1c93e0</PrTab>
      <PrTab as="div" surface="pr-code-toolbar"><PrTab as="span" surface="pr-code-commit-scope">All commits</PrTab><PrTab as="span" surface="pr-code-count">4 files · 1 / 4 viewed</PrTab><PrTab as="div" surface="pr-code-actions"><PrTab as="button" surface="pr-code-action">Wrap</PrTab></PrTab></PrTab>
      <PrTab as="div" surface="pr-code-file"><PrTab as="div" surface="pr-code-file-heading"><PrTab as="span" surface="pr-code-file-status">M</PrTab>src/app.ts<PrTab as="button" surface="pr-code-viewed"><PrTab as="span" surface="pr-code-viewed-box" />Viewed</PrTab></PrTab><PrTab as="div" surface="pr-code-file-body">+ code</PrTab></PrTab>
      <PrTab as="div" surface="pr-code-tree"><PrTab as="button" surface="pr-code-tree-item">src/app.ts</PrTab></PrTab>
      <PrTab as="span" surface="pr-code-layout"><PrTab as="button" surface="pr-code-action" aria-pressed="true">Stacked</PrTab><PrTab as="button" surface="pr-code-action">Split</PrTab></PrTab>
      <ReviewDiffLine variant="pr" kind="add" oldLine={null} newLine={2} text="+ const value = true" />
      <div className={PRS_CLASSES.PRS_CLASS_54}>Check log</div>
      <button type="button" className={PRS_CLASSES.PRS_CLASS_60}>Fix with agent</button>
      <PrTab as="span" surface="pr-check-state-icon" state="passing"><Icon glyph={IconCheck} role="small" /></PrTab>
      <PrTab as="span" surface="pr-check-state-icon" state="failing"><Icon glyph={IconClose} role="small" /></PrTab>
      <div className="relative h-12 w-12"><PrTab as="button" surface="pr-comment-fab" type="button" aria-label="Comment on pull request"><Icon glyph={IconMessageSquare} role="small" /></PrTab></div>
      <PrTab as="div" surface="pr-scroll-header">
        <PrTab as="div" surface="pr-branch-topline"><PrTab as="div" surface="pr-crumb-cell"><PrTab as="div" surface="pr-crumb-expanded" state="hidden">owner/houston #95</PrTab><PrTab as="div" surface="pr-crumb-condensed">#95 Pull request title</PrTab></PrTab></PrTab>
        <PrTab as="div" surface="pr-condensed-row" state="open"><div><PrTab as="div" surface="pr-condensed-inner">main ← branch · 4 files</PrTab></div></PrTab>
        <PrTab as="div" surface="pr-header-fold" state="shut"><div><PrTab as="div" surface="pr-branch-heading">Pull request title</PrTab></div></PrTab>
      </PrTab>
    </div>
  )
}
