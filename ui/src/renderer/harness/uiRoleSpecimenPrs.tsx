import { PRS_CLASSES } from '../src/components/ui/PrsClasses'

export function UiRoleSpecimenPrs(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <div className={PRS_CLASSES.PRS_PR_ROW}>Pull request row</div>
      <div className={PRS_CLASSES.PRS_CHECK_ROW}>Check row</div>
      <div className={PRS_CLASSES.PRS_CLASS_54}>Check log</div>
      <button type="button" className={PRS_CLASSES.PRS_CLASS_60}>Fix with agent</button>
    </div>
  )
}
