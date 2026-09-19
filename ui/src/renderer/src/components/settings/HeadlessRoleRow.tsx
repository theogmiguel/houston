import type { AgentKind, HeadlessRoleView } from '../../houston/client'
import { engineLabel } from '../engineLabel'
import { Select, type SelectOption } from '../Select'
import { Row } from './shared'

const ENGINE_DEFAULT_MODEL = ''

export interface HeadlessRoleRowProps {
  title: string
  desc: React.ReactNode
  view: HeadlessRoleView | null
  onSet: (engine: AgentKind | null, model: string | null) => void
  idPrefix: string
}

export function HeadlessRoleRow({
  title,
  desc,
  view,
  onSet,
  idPrefix
}: HeadlessRoleRowProps): React.JSX.Element {
  if (!view) {
    return (
      <Row title={title} desc={desc}>
        <span className="text-[length:var(--tr-text-base)] text-[var(--text-faint)]">
          Loading…
        </span>
      </Row>
    )
  }

  const current = view.engines.find((o) => o.engine === view.engine)
  const engineOptions: SelectOption[] = view.engines.map((o) => ({
    value: o.engine,
    label: engineLabel(o.engine) + (o.enabled && !o.verified ? ' (not verified)' : ''),
    title: o.reason ?? undefined,
    disabled: !o.enabled
  }))
  const modelOptions: SelectOption[] = [
    { value: ENGINE_DEFAULT_MODEL, label: 'Engine default' },
    ...(current?.models ?? []).map((m) => ({ value: m, label: m }))
  ]

  const commitEngine = (engine: string): void => onSet(engine as AgentKind, null)
  const commitModel = (model: string): void =>
    onSet(
      view.engine_is_default ? null : view.engine,
      model === ENGINE_DEFAULT_MODEL ? null : model
    )

  return (
    <Row
      title={title}
      desc={
        <>
          {desc}{' '}
          {view.engine_is_default && (
            <span className="text-[var(--text-faint)]">
              {engineLabel(view.engine)} · default
            </span>
          )}
        </>
      }
    >
      <div className="flex items-center gap-[var(--space-2)]">
        <Select
          value={view.engine}
          data-testid={`${idPrefix}-engine`}
          options={engineOptions}
          onChange={commitEngine}
        />
        <Select
          value={view.model ?? ENGINE_DEFAULT_MODEL}
          data-testid={`${idPrefix}-model`}
          options={modelOptions}
          onChange={commitModel}
        />
      </div>
    </Row>
  )
}
