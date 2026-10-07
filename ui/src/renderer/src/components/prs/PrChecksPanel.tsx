import { Icon } from '../ui/Icon'
import { PRS_CLASSES } from '../ui/PrsClasses'
import { IconChevronDown } from '../icons'
import { PrChecksList, type PrChecksState } from './usePrChecksState'

export interface PrChecksPanelProps {
  state: PrChecksState
}

export function PrChecksPanel({ state }: PrChecksPanelProps): React.JSX.Element {
  const { failedCount, passedCount, sectionOpen, setSectionOpen } = state
  const checks = state.listProps.checks
  return (
    <div className={PRS_CLASSES.PRS_CLASS_37} data-testid="pr-checks">
      <div className={PRS_CLASSES.PRS_CLASS_70}>
        <button
          type="button"
          className={PRS_CLASSES.PRS_CLASS_71}
          aria-expanded={sectionOpen}
          onClick={() => setSectionOpen((open) => !open)}
        >
          <Icon
            glyph={IconChevronDown}
            role="small"
            className={`${PRS_CLASSES.PRS_ROTATE} ${sectionOpen ? '' : PRS_CLASSES.PRS_ROTATE_CLOSED}`}
          />
          <span>Checks</span>
        </button>
        <span className={failedCount > 0 ? PRS_CLASSES.PRS_CLASS_3 : ''} data-testid="pr-check-summary">
          {failedCount > 0 ? `${failedCount} of ${checks.length} failing` : `${passedCount} passed`}
        </span>
      </div>
      {sectionOpen && <PrChecksList state={state} />}
    </div>
  )
}
