import { FilesSurfaceElement } from '../src/components/ui/FilesSurfaceElement'

export function UiRoleSpecimenFiles(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-[var(--space-2)]">
      <FilesSurfaceElement as="div" role="explorerHead">Files</FilesSurfaceElement>
      <FilesSurfaceElement as="div" role="row" />
      <FilesSurfaceElement as="span" role="fileIcon" />
      <FilesSurfaceElement as="div" role="quickOpenPanel">Quick open</FilesSurfaceElement>
    </div>
  )
}
