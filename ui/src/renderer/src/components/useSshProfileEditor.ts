import type { RefObject } from 'react'
import { useRef, useState } from 'react'
import type { SshAuth, SshProfile } from '../houston/client'

export interface SshProfileFormFields {
  host: string
  setHost: (v: string) => void
  port: string
  setPort: (v: string) => void
  user: string
  setUser: (v: string) => void
  authKind: SshAuth['kind']
  setAuthKind: (v: SshAuth['kind']) => void
  identityPath: string
  setIdentityPath: (v: string) => void
  setPassword: (v: string) => void
  setDefaultDir: (v: string) => void
  setStartupCmd: (v: string) => void
  setProfileName: (v: string) => void
  setSaveAsProfile: (v: boolean) => void
  resetTouched: () => void
  hostInputRef: RefObject<HTMLInputElement | null>
}

export interface SshProfileEditor {
  editingProfileName: string | null
  setEditingProfileName: (v: string | null) => void
  appliedProfile: string | null
  setAppliedProfile: (v: string | null) => void
  applyProfile: (p: SshProfile) => void
  duplicateProfile: (p: SshProfile) => void
  startEdit: (p: SshProfile) => void
  cancelEdit: () => void
}

export function useSshProfileEditor(profiles: SshProfile[], form: SshProfileFormFields): SshProfileEditor {
  const [editingProfileName, setEditingProfileName] = useState<string | null>(null)
  const [appliedProfile, setAppliedProfile] = useState<string | null>(null)
  const editSnapshotRef = useRef<{
    host: string
    port: string
    user: string
    authKind: SshAuth['kind']
    identityPath: string
  } | null>(null)

  const applyProfile = (p: SshProfile): void => {
    form.setHost(p.host)
    form.setPort(String(p.port))
    form.setUser(p.user)
    form.setAuthKind(p.auth.kind)
    form.setIdentityPath(p.auth.kind === 'identity_file' ? p.auth.path : '')
    form.setPassword('')
    form.setDefaultDir(p.default_dir ?? '')
    form.setStartupCmd(p.startup_cmd ?? '')
    setAppliedProfile(p.name)
  }

  const duplicateProfile = (p: SshProfile): void => {
    applyProfile(p)
    setEditingProfileName(null)
    setAppliedProfile(null)
    const taken = new Set(profiles.map((x) => x.name))
    let name = `${p.name} copy`
    for (let n = 2; taken.has(name); n++) name = `${p.name} copy ${n}`
    form.setProfileName(name)
    form.setSaveAsProfile(true)
    form.hostInputRef.current?.focus()
  }

  const startEdit = (p: SshProfile): void => {
    editSnapshotRef.current = {
      host: form.host,
      port: form.port,
      user: form.user,
      authKind: form.authKind,
      identityPath: form.identityPath
    }
    applyProfile(p)
    setEditingProfileName(p.name)
    form.resetTouched()
    form.hostInputRef.current?.focus()
  }

  const cancelEdit = (): void => {
    const snap = editSnapshotRef.current
    if (snap) {
      form.setHost(snap.host)
      form.setPort(snap.port)
      form.setUser(snap.user)
      form.setAuthKind(snap.authKind)
      form.setIdentityPath(snap.identityPath)
    }
    editSnapshotRef.current = null
    setEditingProfileName(null)
    form.resetTouched()
    form.hostInputRef.current?.focus()
  }

  return {
    editingProfileName,
    setEditingProfileName,
    appliedProfile,
    setAppliedProfile,
    applyProfile,
    duplicateProfile,
    startEdit,
    cancelEdit
  }
}
