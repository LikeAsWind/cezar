import { useId, type ComponentProps, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

const actionClasses = 'flex shrink-0 items-center gap-2 [&_button]:min-h-11 [&_button]:min-w-11 [&_a]:inline-flex [&_a]:min-h-11 [&_a]:min-w-11 md:[&_button]:min-h-9 md:[&_button]:min-w-9 md:[&_a]:min-h-9 md:[&_a]:min-w-9'

export function PageFrame({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex min-h-full min-w-0 flex-col', className)} {...props} />
}

export function PageHeader({ title, description, actions, className }: {
  title: string
  description?: string
  actions?: ReactNode
  className?: string
}) {
  const titleId = useId()
  const descriptionId = useId()
  return (
    <header data-slot="page-header" className={cn('sticky top-0 z-10 flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-b border-border bg-background px-3 py-2 md:h-14 md:flex-nowrap md:px-5 md:py-0', className)}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 md:flex-row md:items-center md:gap-3">
        <h1 id={titleId} aria-describedby={description ? descriptionId : undefined} className="text-base font-semibold tracking-tight">{title}</h1>
        {description ? <p id={descriptionId} className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div data-slot="page-actions" role="group" aria-labelledby={titleId} className={actionClasses}>{actions}</div> : null}
    </header>
  )
}

export function PageContent({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="page-content" className={cn('flex min-w-0 flex-1 flex-col gap-4 p-3 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-5 md:pb-5', className)} {...props} />
}

export function OverviewSection({ title, description, action, children, className }: {
  title: string
  description?: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  const titleId = useId()
  const descriptionId = useId()
  return (
    <section aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} className={cn('flex min-w-0 flex-col gap-3', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 id={titleId} className="text-sm font-semibold">{title}</h2>
          {description ? <p id={descriptionId} className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {action ? <div className={actionClasses}>{action}</div> : null}
      </div>
      {children}
    </section>
  )
}
