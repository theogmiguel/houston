import { useEffect } from 'react'
import { PrFiles } from '../src/components/git/PrFiles'
import type { PrDiffView } from '../src/components/git/usePrDetailSubscription'
import { ChangesStory } from './changesStories'

const noop = (): void => {}

const patch = `diff --git a/core/orchestrate.rs b/core/orchestrate.rs
--- a/core/orchestrate.rs
+++ b/core/orchestrate.rs
@@ -10,2 +10,3 @@
-    wake_parent(parent);
+    for parent in parents {
+        wake_parent(parent);
+    }
diff --git a/core/inbox.rs b/core/inbox.rs
--- a/core/inbox.rs
+++ b/core/inbox.rs
@@ -40,3 +40,4 @@ impl Inbox {
     let rows = self.pending();
-    rows.into_iter().for_each(deliver);
+    // One wake per parent, however many rows it has.
+    group_by_parent(rows).for_each(deliver);
`

function useScriptedFind(rootSelector: string, term: string, enterPresses: number): void {
  useEffect(() => {
    let cancelled = false
    const run = (attempt: number): void => {
      if (cancelled) return
      const root = document.querySelector<HTMLElement>(rootSelector)
      if (!root || !root.querySelector('[data-kind="add"]')) {
        if (attempt < 50) window.setTimeout(() => run(attempt + 1), 50)
        return
      }
      root.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true, cancelable: true }))
      window.setTimeout(() => {
        if (cancelled) return
        const input = document.querySelector<HTMLInputElement>('[data-testid="diff-find-input"]')
        if (!input) return
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, term)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        for (let i = 1; i <= enterPresses; i++) {
          window.setTimeout(() => !cancelled && input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })), i * 30)
        }
      }, 50)
    }
    const start = window.setTimeout(() => run(0), 0)
    return () => {
      cancelled = true
      window.clearTimeout(start)
    }
  }, [rootSelector, term, enterPresses])
}

export function PrFilesFindCapture(): React.JSX.Element {
  useScriptedFind('[data-testid="pr-files"]', 'parent', 6)
  return <div className="h-full overflow-auto bg-[var(--content-bg)]"><PrFiles link={null} diff={{ number: 412, patch, truncated: false, message: null } as PrDiffView} loading={false} drafts={[]} writeBusy={false} onAddDraft={noop} onReload={noop} /></div>
}

export function ChangesFindStory(): React.JSX.Element {
  useScriptedFind('[data-testid="changes-pane"]', 'render', 1)
  return <ChangesStory ready />
}
