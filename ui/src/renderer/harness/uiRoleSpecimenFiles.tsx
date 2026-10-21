import { ContentSearchRow, FilesSurfaceElement } from '../src/components/ui/FilesSurfaceElement'

export function UiRoleSpecimenFiles(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-[var(--space-2)]">
      <FilesSurfaceElement as="div" role="explorerHead">Files</FilesSurfaceElement>
      <FilesSurfaceElement as="div" role="row" />
      <FilesSurfaceElement as="span" role="fileIcon" />
      <FilesSurfaceElement as="div" role="quickOpenPanel">Quick open</FilesSurfaceElement>
      <FilesSurfaceElement as="div" role="contentSearchFile"><span>src/App.tsx</span></FilesSurfaceElement>
      <ContentSearchRow type="button" highlighted={false}>
        <FilesSurfaceElement as="span" role="contentSearchLine">12</FilesSurfaceElement>
        <FilesSurfaceElement as="span" role="contentSearchText">const <mark>needle</mark> = 1</FilesSurfaceElement>
      </ContentSearchRow>
      <ContentSearchRow type="button" highlighted>
        <FilesSurfaceElement as="span" role="contentSearchLine">40</FilesSurfaceElement>
        <FilesSurfaceElement as="span" role="contentSearchText"><mark>needle</mark>()</FilesSurfaceElement>
      </ContentSearchRow>
      <FilesSurfaceElement as="div" role="floatingGlass">Files menu material</FilesSurfaceElement>
      <FilesSurfaceElement as="div" role="openInMenu">
        <FilesSurfaceElement as="div" role="openInLabel">Open file in</FilesSurfaceElement>
        <FilesSurfaceElement as="button" role="openInOption">VS Code</FilesSurfaceElement>
      </FilesSurfaceElement>
    </div>
  )
}
