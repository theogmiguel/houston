import { useEffect, useRef, useState } from 'react'
import { isTauri } from '../houston/host'
import { usePickerEvent, type PickerSelection } from '../houston/browserPicker'
import {
  BrowserPickerAgentSelect,
  BrowserPickerHint,
  BrowserPickerInputRow,
  BrowserPickerPromptInput,
  BrowserPickerSelectionRow,
  BrowserPickerSubmitButton,
  BrowserStatusBand
} from './ui/BrowserSurface'

export const PICKER_AGENTS: { id: string; name: string; description: string }[] = [
  {
    id: 'terminal',
    name: 'Terminal',
    description: 'the active session, or the first live one in this workspace'
  }
]
const DEFAULT_AGENT_ID = PICKER_AGENTS[0].id

async function invokePicker(cmd: string, args: Record<string, unknown>): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke<void>(cmd, args)
}

export interface PickerController {
  enabled: boolean
  toggle: () => void
  selection: PickerSelection | null
  promptInput: string
  setPromptInput: (v: string) => void
  agentId: string
  setAgentId: (v: string) => void
  agents: typeof PICKER_AGENTS
  submitting: boolean
  submit: () => void
  clearSelection: () => void
  pickerError: string | null
  dismissError: () => void
}

export function usePickerController(id: string, disabled: boolean, onSendToTerminal?: (text: string) => void): PickerController {
  const [enabled, setEnabledState] = useState(false)
  const [selection, setSelection] = useState<PickerSelection | null>(null)
  const [promptInput, setPromptInput] = useState('')
  const [agentId, setAgentId] = useState(DEFAULT_AGENT_ID)
  const [submitting, setSubmitting] = useState(false)
  const [pickerError, setPickerError] = useState<string | null>(null)

  const event = usePickerEvent(id)
  const onSendToTerminalRef = useRef(onSendToTerminal)
  onSendToTerminalRef.current = onSendToTerminal
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  useEffect(() => {
    if (!event) return
    if (event.type === 'element-selected') {
      const { type: _type, id: _id, ...rest } = event
      setSelection(rest)
    } else if (event.type === 'element-deselected') {
      setSelection(null)
    } else if (event.type === 'prompt-submitted') {
      setSubmitting(false)
      const target = PICKER_AGENTS.find((a) => a.id === event.agentId)
      if (!target) {
        setPickerError(
          `picker: prompt-submitted named agent ${JSON.stringify(event.agentId)}, which is not ` +
            `one of this picker's offered agents (${PICKER_AGENTS.map((a) => a.id).join(', ')})`
        )
        return
      }
      if (!onSendToTerminalRef.current) {
        setPickerError('picker: no terminal is available to receive this prompt')
        return
      }
      onSendToTerminalRef.current(event.wrappedPrompt)
      setPromptInput('')
      setSelection(null)
      setPickerError(null)
      void invokePicker('browser_clear_picker_selection', { id }).catch(() => {})
    }
  }, [event, id])

  useEffect(() => {
    if (enabled && disabled) {
      setEnabledState(false)
      setSelection(null)
      void invokePicker('browser_set_picker_mode', { id, enabled: false, config: null }).catch(() => {})
    }
  }, [enabled, disabled, id])

  useEffect(
    () => () => {
      if (enabledRef.current) {
        void invokePicker('browser_set_picker_mode', { id, enabled: false, config: null }).catch(() => {})
      }
    },
    [id]
  )

  const clearSelection = (): void => {
    if (!enabled) return
    void invokePicker('browser_clear_picker_selection', { id })
      .then(() => setSelection(null))
      .catch((err: unknown) => {
        setPickerError(
          `picker: clearing the selection for ${JSON.stringify(id)} failed: ` +
            `${err instanceof Error ? err.message : String(err)}`
        )
      })
  }

  useEffect(() => {
    if (!enabled) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') clearSelection()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  const toggle = (): void => {
    if (!isTauri()) return
    const next = !enabled
    setPickerError(null)
    void invokePicker(
      'browser_set_picker_mode',
      next
        ? { id, enabled: true, config: { agents: PICKER_AGENTS, preferredAgent: agentId } }
        : { id, enabled: false, config: null }
    )
      .then(() => {
        setEnabledState(next)
        if (!next) {
          setSelection(null)
          setPromptInput('')
        }
      })
      .catch((err: unknown) => {
        setPickerError(
          `picker: could not ${next ? 'enable' : 'disable'} for ${JSON.stringify(id)}: ` +
            `${err instanceof Error ? err.message : String(err)}`
        )
      })
  }

  const submit = (): void => {
    if (!enabled || !selection || !promptInput.trim() || submitting) return
    if (!onSendToTerminalRef.current) {
      setPickerError('picker: no terminal is available to receive this prompt')
      return
    }
    setSubmitting(true)
    setPickerError(null)
    void invokePicker('browser_submit_picker_prompt', {
      id,
      userPrompt: promptInput.trim(),
      agentId
    }).catch((err: unknown) => {
      setSubmitting(false)
      setPickerError(
        `picker: submitting the prompt for ${JSON.stringify(id)} failed: ` +
          `${err instanceof Error ? err.message : String(err)}`
      )
    })
  }

  return {
    enabled,
    toggle,
    selection,
    promptInput,
    setPromptInput,
    agentId,
    setAgentId,
    agents: PICKER_AGENTS,
    submitting,
    submit,
    clearSelection,
    pickerError,
    dismissError: () => setPickerError(null)
  }
}

export function PickerStrip({ id, controller }: { id: string; controller: PickerController }): React.JSX.Element {
  const { enabled, selection } = controller
  return (
    <>
      {enabled && (
        <BrowserPickerHint role="status" data-testid={`browser-picker-hint-${id}`}>Selecting elements. Links are paused.</BrowserPickerHint>
      )}
      {enabled && selection && (
        <BrowserPickerSelectionRow data-testid={`browser-picker-selection-${id}`} tag={`<${selection.tagName.toLowerCase() || '?'}>`} component={selection.componentName} status="links paused" />
      )}
      {enabled && selection && (
        <BrowserPickerInputRow>
          <BrowserPickerPromptInput
            placeholder="Describe the change…"
            aria-label="Describe the change to the selected element"
            value={controller.promptInput}
            onChange={(e) => controller.setPromptInput(e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter' && controller.promptInput.trim()) controller.submit()
            }}
          />
          <BrowserPickerAgentSelect
            aria-label="Agent to send the prompt to"
            value={controller.agentId}
            options={controller.agents.map((a) => ({
              value: a.id,
              label: a.name,
              title: a.description
            }))}
            onChange={(v) => controller.setAgentId(v)}
          />
          <BrowserPickerSubmitButton
            type="button"
            disabled={!controller.promptInput.trim() || controller.submitting}
            aria-busy={controller.submitting}
            data-testid={`browser-picker-submit-${id}`}
            onClick={() => controller.submit()}
          >
            {controller.submitting ? 'Sending…' : 'Send'}
          </BrowserPickerSubmitButton>
        </BrowserPickerInputRow>
      )}
      {controller.pickerError && (
        <BrowserStatusBand
          tone="danger"
          edge="top"
          indicator
          data-testid={`browser-picker-error-${id}`}
          dismiss={{ label: 'Dismiss picker error', onClick: controller.dismissError }}
        >
          {controller.pickerError}
        </BrowserStatusBand>
      )}
    </>
  )
}
