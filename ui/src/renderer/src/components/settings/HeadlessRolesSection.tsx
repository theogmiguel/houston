import type { AgentKind, HeadlessRoleKind, HeadlessRoleView } from '../../houston/client'
import { HeadlessRoleRow } from './HeadlessRoleRow'
import { Group, SectionHead } from './shared'

export interface HeadlessRolesSectionProps {
  headlessWriter: HeadlessRoleView | null
  onHeadlessRoleSet: (role: HeadlessRoleKind, engine: AgentKind | null, model: string | null) => void
}

export function HeadlessRolesSection({
  headlessWriter,
  onHeadlessRoleSet
}: HeadlessRolesSectionProps): React.JSX.Element {
  return (
    <>
      <SectionHead
        title="Houston's own agents"
        lede="One role Houston runs without a pane, on your own account. Pick the engine and model it uses; nothing else about it is configurable."
      />
      <Group heading="Write with AI">
        <HeadlessRoleRow
          title="Writer"
          desc="Writes a commit message from the staged diff, and a pull request title and body from the branch's commits, on your own account. The Changes panel shows its text in an editable control before anything is committed or opened."
          view={headlessWriter}
          onSet={(engine, model) => onHeadlessRoleSet('writer', engine, model)}
          idPrefix="settings-git-writer"
        />
      </Group>
    </>
  )
}
