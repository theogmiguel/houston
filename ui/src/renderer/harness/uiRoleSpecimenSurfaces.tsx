import React from 'react'
import { PrTab } from '../src/components/ui/PrTab'
import { ShellElement } from '../src/components/ui/ShellPrimitives'

export function UiRoleSpecimenSurfaces(): React.JSX.Element {
  return (
    <div className="grid content-start gap-[var(--space-2)]">
      <PrTab as="div" surface="pr-tab-toolbar">
        <PrTab as="span" surface="pr-number">#1284</PrTab>
        <PrTab as="span" surface="pr-label-pill"><PrTab as="span" surface="pr-label-dot" />design</PrTab>
      </PrTab>
      <PrTab as="div" surface="changes-diff-toolbar">
        <PrTab as="span" surface="changes-diff-stat">+42 −7</PrTab>
      </PrTab>
      <ShellElement as="div" shellRole="panel-header">
        <ShellElement as="span" shellRole="panel-pr-icon" state="ok">PR</ShellElement>
        <ShellElement as="span" shellRole="panel-pr-icon" state="stop">PR</ShellElement>
      </ShellElement>
      <ShellElement as="div" shellRole="browser-toolbar">
        <ShellElement as="div" shellRole="browser-address">localhost:5173</ShellElement>
        <ShellElement as="span" shellRole="browser-count">2</ShellElement>
      </ShellElement>
    </div>
  )
}
