import { t, useLocale, numberFormat } from '@/lib/i18n'
import { compactTokens } from '@/lib/format'
import { cn } from '@/lib/utils'

interface DirectionalUsageProps {
  inputTokens?: number
  outputTokens?: number
  /** Compact prose (`IN … · OUT …`) or the desktop table's denser (`… / …`) form. */
  variant?: 'compact' | 'table'
  /** Historical compact surfaces disappear when neither direction was persisted. */
  omitWhenUnknown?: boolean
  className?: string
}

function exactTokens(value: number | undefined): string {
  return value === undefined ? 'unknown' : numberFormat({}).format(value)
}

export function directionalUsageLabel(inputTokens?: number, outputTokens?: number): string {
  return t('Input tokens: {0}; output tokens: {1}', { 0: exactTokens(inputTokens), 1: exactTokens(outputTokens) })
}

export function directionalUsageText(
  inputTokens?: number,
  outputTokens?: number,
  variant: 'compact' | 'table' = 'compact',
): string {
  const input = inputTokens === undefined ? '—' : compactTokens(inputTokens)
  const output = outputTokens === undefined ? '—' : compactTokens(outputTokens)
  return variant === 'table' ? `${input} / ${output}` : t('IN {0} · OUT {1}', { 0: input, 1: output })
}

/** One honest input/output rendering shared by header, table, cards, quick lists, and variants. */
export function DirectionalUsage({
  inputTokens,
  outputTokens,
  variant = 'compact',
  omitWhenUnknown = true,
  className,
}: DirectionalUsageProps) {
  useLocale()

  if (omitWhenUnknown && inputTokens === undefined && outputTokens === undefined) return null

  return (
    <span
      data-slot="directional-usage"
      aria-label={directionalUsageLabel(inputTokens, outputTokens)}
      className={cn('font-mono tabular-nums', className)}
    >
      {directionalUsageText(inputTokens, outputTokens, variant)}
    </span>
  )
}
