import { useId, type ReactNode } from 'react'
import { Link } from 'react-router'

import { cn } from '@/lib/utils'

export const interactiveItemClasses = 'min-h-11 min-w-11 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:min-h-9 md:min-w-9'

export function OverviewLinkCard({ to, title, description, status, metadata, icon, className }: {
  to: string
  title: string
  description?: string
  status?: ReactNode
  metadata?: ReactNode
  icon?: ReactNode
  className?: string
}) {
  const titleId = useId()
  const descriptionId = useId()
  return (
    <Link
      to={to}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      className={cn(
        'group flex items-start gap-3 rounded-lg border border-border bg-card p-3 text-card-foreground shadow-xs transition-colors hover:bg-muted focus-visible:ring-ring/50 md:p-4',
        interactiveItemClasses,
        className,
      )}
    >
      {icon ? <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span> : null}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center justify-between gap-2">
          <span id={titleId} className="truncate text-sm font-semibold">{title}</span>
          {status ? <span className="shrink-0">{status}</span> : null}
        </span>
        {description ? <span id={descriptionId} className="mt-1 block text-xs text-muted-foreground">{description}</span> : null}
        {metadata ? <span className="mt-2 block truncate text-xs text-muted-foreground">{metadata}</span> : null}
      </span>
    </Link>
  )
}
