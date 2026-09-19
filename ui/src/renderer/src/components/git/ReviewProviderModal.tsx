import { useState } from 'react'
import type { AgentKind } from '../../houston/client'
import { BTN_GHOST, BTN_PRIMARY } from '../buttonChrome'
import { Icon, ICON_ROLE_CLS } from '../Icon'
import { IconAgent, IconCheck } from '../icons'
import {
  PICKER_LABEL_CLS,
  TILE_AGENT_CLS,
  TILE_BASE,
  TILE_IDLE,
  TILE_SELECTED
} from '../pickerChrome'
import { AGENT_LABEL, COMPOSER_AGENTS } from '../sessionPresets'
import { engineGlyphColor } from '../SessionPane'
import { GitDialogShell } from './GitDialogShell'

const REVIEW_PROVIDERS: readonly AgentKind[] = COMPOSER_AGENTS.filter((a) => a !== 'shell')

export function ReviewProviderModal({
  onCancel,
  onStart
}: {
  onCancel: () => void
  onStart: (agent: AgentKind) => void
}): React.JSX.Element {
  const [pick, setPick] = useState<AgentKind | null>(null)

  return (
    <GitDialogShell
      heading="Review with agent"
      testid="review-provider-modal"
      onClose={onCancel}
      footer={
        <>
          <button type="button" className={`btn ${BTN_GHOST}`} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${BTN_PRIMARY}`}
            data-testid="review-provider-start"
            disabled={pick === null}
            onClick={() => {
              if (pick !== null) onStart(pick)
            }}
          >
            Start review
          </button>
        </>
      }
    >
      <fieldset className="m-0 flex flex-col gap-[8px] border-0 p-0">
        <legend className={`${PICKER_LABEL_CLS} p-0`}>Engine</legend>
        <div className="grid grid-cols-2 gap-[8px]">
          {REVIEW_PROVIDERS.map((a) => {
            const selected = pick === a
            return (
              <button
                key={a}
                type="button"
                data-agent={a}
                data-testid={`review-provider-${a}`}
                aria-pressed={selected}
                onClick={() => setPick(a)}
                className={`${TILE_BASE} ${selected ? TILE_SELECTED : TILE_IDLE} ${TILE_AGENT_CLS}`}
              >
                <span className="flex-none" style={{ color: engineGlyphColor(a) }}>
                  <IconAgent agent={a} className={ICON_ROLE_CLS.ui} />
                </span>
                <span
                  className={`flex-1 truncate [font-size:var(--tr-text-small-size)] ${
                    selected
                      ? 'font-semibold text-[var(--text-primary)]'
                      : 'font-medium text-[var(--text-muted)]'
                  }`}
                >
                  {AGENT_LABEL[a] ?? a}
                </span>
                {selected && (
                  <span className="flex h-[14px] w-[14px] flex-none items-center justify-center rounded-full bg-[var(--accent)] text-white">
                    <Icon glyph={IconCheck} role="label" />
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </fieldset>
    </GitDialogShell>
  )
}
