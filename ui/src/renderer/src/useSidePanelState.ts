import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { isLive, type SessionInfo } from './houston/client'
import { SIDE_OPEN_EVENT, SIDE_SELECT_EVENT, type SideOpen } from './sidePanel'

export function useSidePanelState(selectedWorkspace: string, activeId: number | null, sessions: ReadonlyMap<number, SessionInfo>, scmOpen: boolean, setScmOpen: Dispatch<SetStateAction<boolean>>, _revealWorkspace: (workspace: string) => void) {
  const [sideRequest, setSideRequest] = useState<SideOpen | null>(null);
  const [activeSurface, setActiveSurface] = useState<"grid" | "side">("grid");
  const sideWorkspaceRef = useRef<string>("all");
  if (activeId !== null && sessions.get(activeId)?.project_dir) sideWorkspaceRef.current = sessions.get(activeId)!.project_dir;
  const sideWorkspace = selectedWorkspace === "all" ? sideWorkspaceRef.current : selectedWorkspace;
  const pickerTarget = useRef<number | null>(null);
  if (activeId !== null && isLive(sessions.get(activeId)?.state ?? "exited") && sessions.get(activeId)?.agent !== "shell") pickerTarget.current = activeId;
  const [sideReview, setSideReview] = useState<SessionInfo | null>(null);
  useEffect(() => {
    const open = (event: Event): void => {
      const request = (event as CustomEvent<SideOpen>).detail;
      setSideRequest(request);
      setScmOpen(true);
      setActiveSurface("side");
    };
    const select = (): void => setActiveSurface("grid");
    window.addEventListener(SIDE_OPEN_EVENT, open);
    window.addEventListener(SIDE_SELECT_EVENT, select);
    return () => { window.removeEventListener(SIDE_OPEN_EVENT, open); window.removeEventListener(SIDE_SELECT_EVENT, select); };
  }, []);
  useEffect(() => { if (!scmOpen) setActiveSurface("grid"); }, [scmOpen]);
  return { sideRequest, setSideRequest, activeSurface, setActiveSurface, sideWorkspaceRef, sideWorkspace, pickerTarget, sideReview, setSideReview };
}

export function focusSideBrowserUrl(surface: 'grid' | 'side', _event: KeyboardEvent): boolean {
  if (surface !== 'side') return false
  const address = document.querySelector<HTMLInputElement>(
    '.browser-surface[data-active="true"] input[aria-label="Address"]'
  )
  if (!address) return false
  _event.preventDefault()
  address.focus()
  return true
}
