import type { StepInput, WorkflowGraphNode } from '@open-mercato/cezar-api-client'
import { t, useLocale } from '@/lib/i18n'

export function NodeInput({ node, input, task }: { node: WorkflowGraphNode; input?: StepInput; task?: string }) {
  useLocale()
  const configuration = node.type === 'agent' ? node.prompt ?? '{{task}}'
    : node.type === 'check' ? node.command
      : node.type === 'if' ? JSON.stringify(node.condition, null, 2)
        : node.type === 'loop' ? JSON.stringify({ max: node.max })
          : node.type === 'start' ? task ?? '' : JSON.stringify(node, null, 2)
  const fields = input
    ? [['userPrompt', input.userPrompt], ['systemPrompt', input.systemPrompt], ['command', input.command]] as const
    : [['configuration', configuration]] as const
  return (
    <section className="space-y-2">
      <h3 className="text-[11px] text-muted-foreground uppercase">{t('Inputs')}</h3>
      <p className="text-[11px] text-muted-foreground">
        {input ? t('Latest launch input supplied by cezar') : t('No recorded launch input. Showing node configuration only.')}
      </p>
      {input ? (
        <dl className="space-y-1 break-all text-[11px]">
          <div>{t('Captured at')}: {input.capturedAt}</div>
          <div>{t('Working directory')}: {input.cwd}</div>
          {input.model ? <div>{t('Model')}: {input.model}</div> : null}
          {input.resume ? <div>{t('Resumed session; previous conversation history is not repeated here.')}</div> : null}
          {input.truncatedFields?.length ? <div>{t('Display snapshot truncated')}: {input.truncatedFields.join(', ')}</div> : null}
        </dl>
      ) : null}
      {fields.map(([name, value]) => value !== undefined ? (
        <details key={name} open={name !== 'systemPrompt'}>
          <summary className="cursor-pointer text-[11px] text-muted-foreground">{name}</summary>
          <pre className="mt-1 max-h-72 overflow-auto rounded-md bg-muted/40 p-2 text-[11px] whitespace-pre-wrap break-words">{value}</pre>
        </details>
      ) : null)}
    </section>
  )
}
