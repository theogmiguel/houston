import { ActivityDot } from '../src/components/ui/ActivityDot'
import { NoticeToast } from '../src/components/ui/NoticeToast'
import { PaneHeader } from '../src/components/ui/PaneHeader'
import { PaneTitle } from '../src/components/ui/PaneTitle'

export function FoundationMotionStory(): React.JSX.Element {
  return <div className="grid gap-4 p-6">
    <PaneHeader><ActivityDot state="working" active label="Working" /><PaneTitle editable>Terminal session</PaneTitle></PaneHeader>
    <NoticeToast anchor="workspace-top" code="copied" kind="success" heading="Copied 200 lines" />
    <NoticeToast anchor="pane-corner" code="saved" kind="success" heading="Saved changes" />
  </div>
}
