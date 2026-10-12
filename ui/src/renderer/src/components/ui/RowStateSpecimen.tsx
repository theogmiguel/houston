import { IconSearch } from '../icons'
import { ROW_STATE } from './rowState'
import { NavigationRailItem } from './NavigationRail'
import { SettingsRailRow } from './SettingsRailRow'
import { WorkspaceTreeRow } from './WorkspaceTreeRow'
import { ContextMenu, ContextMenuItem, ContextMenuItems } from './ContextMenu'
import { MenuItem } from './MenuItem'
import { GitToolMenuItem } from './Menu'
import { Chip } from './Chip'
import { Select } from './Select'
import { TreeRow } from './FileExplorer'
import { PrTab } from './PrTab'
import { PRS_CLASSES } from './PrsClasses'

export function RowStateSpecimen(): React.JSX.Element {
  return <div data-testid="row-state-specimen" className="grid grid-cols-2 gap-6 p-6">
    <section><h3>Recipe: rest / selected</h3>{(['rest', 'selected'] as const).map((state) => <button key={state} type="button" className={`block w-full px-3 py-2 text-left ${ROW_STATE[state]}`}>{state}</button>)}</section>
    <section><h3>Navigation</h3><NavigationRailItem icon={IconSearch} label="Selected navigation" selected /><NavigationRailItem icon={IconSearch} label="Rest navigation" /></section>
    <section><h3>Settings</h3><SettingsRailRow kind="section" icon={IconSearch} label="Selected settings" selected /><SettingsRailRow kind="section" icon={IconSearch} label="Rest settings" /></section>
    <section><h3>Workspace</h3><WorkspaceTreeRow kind="tree" selected role="button" tabIndex={0}>Selected workspace</WorkspaceTreeRow><WorkspaceTreeRow kind="plain" role="button" tabIndex={0}>Rest workspace</WorkspaceTreeRow></section>
    <section><h3>Menus</h3><div className="grid gap-2"><ContextMenu role="menu" style={{ position: 'static', inset: 'auto' }}><ContextMenuItems><ContextMenuItem>Context item</ContextMenuItem><ContextMenuItem disabled>Disabled context item</ContextMenuItem></ContextMenuItems></ContextMenu><MenuItem>Menu item</MenuItem><GitToolMenuItem>Git tool item</GitToolMenuItem></div></section>
    <section><h3>Select (open, then hover or arrow)</h3><Select aria-label="Row state select" value="one" options={[{ value: 'one', label: 'Current option' }, { value: 'two', label: 'Other option' }]} onChange={() => {}} /></section>
    <section><h3>Choice chips</h3><Chip variant="choice" label="Selected choice" selected onClick={() => {}} /><Chip variant="choice" label="Rest choice" onClick={() => {}} /></section>
    <section><h3>File tree (Tab for focus ring)</h3><TreeRow depth={0} split selected failed={false}>Selected file</TreeRow><TreeRow depth={0} split selected={false} failed={false}>Rest file</TreeRow></section>
    <section><h3>Pull requests</h3><div role="button" tabIndex={0} aria-current="true" className={`${PRS_CLASSES.PRS_PR_ROW} ${PRS_CLASSES.PRS_PR_ROW_SELECTED}`}>Selected pull request</div><div role="button" tabIndex={0} className={`${PRS_CLASSES.PRS_PR_ROW} ${PRS_CLASSES.PRS_PR_ROW_REST}`}>Rest pull request</div></section>
    <section><h3>PR toolbar: pressed / rest</h3><PrTab as="button" type="button" surface="pr-code-action" aria-pressed aria-label="Pressed toolbar">✓</PrTab><PrTab as="button" type="button" surface="pr-code-action" aria-pressed={false} aria-label="Rest toolbar">¶</PrTab></section>
  </div>
}
