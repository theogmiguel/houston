import type { HTMLAttributes, ReactNode } from 'react'
import { Text } from './Text'
import { TextInput } from './TextInput'

export function ProfilePanel({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--content-bg)]">{children}</div>
}

export function ProfileHeader({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex items-center justify-between gap-[var(--space-2)] border-b border-[var(--divider)] px-[var(--tr-space-profile-inline)] py-[var(--tr-space-profile-header-block)]">{children}</div>
}

export function ProfileActiveSection({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <div {...props} className="grid gap-[var(--space-1-5)] px-[var(--tr-space-profile-inline)] py-[var(--space-2)]">{children}</div>
}

export function ProfileDescription({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text leading="profile-description" size="small" weight="small" tone="muted">{children}</Text>
}

export function ProfileValue({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text mono size="small" weight="small" tone="faint">{children}</Text>
}

export function ProfileSavedList({ children }: { children: ReactNode }): React.JSX.Element {
  return <ul className="border-t border-[var(--divider)]">{children}</ul>
}

export function ProfileSavedHeading({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <div {...props} className="border-t border-[var(--divider)] px-[var(--tr-space-profile-inline)] pt-[var(--tr-space-profile-saved-top)] pb-[var(--tr-space-profile-saved-bottom)]">{children}</div>
}

export function ProfileSavedRow({ children }: { children: ReactNode }): React.JSX.Element {
  return <li className="flex items-center justify-between gap-[var(--space-2)] border-b border-[var(--divider)] last:border-b-0 px-[var(--tr-space-profile-inline)] py-[var(--tr-space-profile-row-block)]">{children}</li>
}

export function ProfileFormRow({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <div {...props} className="flex items-end gap-[var(--space-2)] border-t border-[var(--divider)] px-[var(--tr-space-profile-inline)] py-[var(--tr-space-profile-header-block)]">{children}</div>
}

export function ProfileFormField({ children, grow = 'one' }: { children: ReactNode; grow?: 'one' | 'two' }): React.JSX.Element {
  return <div className={`flex flex-col gap-[var(--space-1)] ${grow === 'two' ? 'flex-[2]' : 'flex-1'}`}>{children}</div>
}

export function ProfileName({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text className="truncate" size="small" weight="small" tone="primary">{children}</Text>
}

export function ProfilePath({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text className="truncate" mono size="small" weight="small" tone="muted">{children}</Text>
}

export function ProfileFieldLabel({ children, variant = 'section' }: { children: ReactNode; variant?: 'section' | 'input' }): React.JSX.Element {
  return variant === 'section'
    ? <Text as="label" className="block" size="label" weight="label" tone="faint" caps>{children}</Text>
    : <Text as="label" className="block" size="small" weight="small" tone="faint">{children}</Text>
}

export function ProfileNotice({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--surface-hover)] px-[var(--space-3)] py-[var(--space-2)]"><Text as="div" size="small" weight="small" leading="normal" tone="secondary">{children}</Text></div>
}

export function ProfilePanelSpecimen(): React.JSX.Element {
  return <ProfilePanel><ProfileHeader><Text size="ui" weight="ui" tone="primary">Agent profile</Text><ProfileValue>CODEX_HOME</ProfileValue></ProfileHeader><ProfileActiveSection><ProfileDescription>The account exported to panes Houston launches.</ProfileDescription><ProfileFieldLabel>Spawned panes — active profile</ProfileFieldLabel></ProfileActiveSection><ProfileSavedHeading><ProfileFieldLabel>Saved profiles</ProfileFieldLabel></ProfileSavedHeading><ProfileSavedList><ProfileSavedRow><ProfileName>Work</ProfileName><ProfilePath>~/.codex-work</ProfilePath></ProfileSavedRow></ProfileSavedList><ProfileFormRow><ProfileFormField><ProfileFieldLabel variant="input">Name</ProfileFieldLabel></ProfileFormField><ProfileFormField grow="two"><ProfileFieldLabel variant="input">Directory</ProfileFieldLabel></ProfileFormField><TextInput variant="compact" value="Add" readOnly /></ProfileFormRow></ProfilePanel>
}
