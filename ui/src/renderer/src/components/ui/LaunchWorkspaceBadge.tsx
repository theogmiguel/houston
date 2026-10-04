interface LaunchWorkspaceBadgeProps {
  logoUrl: string
  workspaceName: string
}

export function LaunchWorkspaceBadge({ logoUrl, workspaceName }: LaunchWorkspaceBadgeProps): React.JSX.Element {
  return (
    <span className="inline-flex h-[var(--h-ctl-mini)] flex-none items-center gap-[6px] rounded-[var(--tr-radius-sm)] bg-[var(--card-hover)] pl-[7px] pr-[9px] [font-size:var(--tr-text-small-size)] font-bold text-[var(--text-primary)]">
      <img src={logoUrl} alt="" width={15} height={15} className="block flex-none" />
      <span className="max-w-[180px] truncate">{workspaceName}</span>
    </span>
  )
}
