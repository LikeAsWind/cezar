import type { StepInput } from '@open-mercato/cezar-api-client'
import { t, useLocale } from '@/lib/i18n'

export function AgentLaunchCard({ input }: { input: StepInput }) {
  useLocale()
  const parameters = {
    stepId: input.stepId,
    nodeName: input.nodeName,
    skill: input.skill,
    backend: input.backend,
    model: input.model,
    cwd: input.cwd,
    sessionId: input.sessionId,
    resume: input.resume,
    timeoutMs: input.timeoutMs,
    additionalDirectories: input.additionalDirectories,
    imageCount: input.imageCount,
  }
  const tools = input.probeRestricted
    ? { tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'], policy: 'project-probe', mcpServers: [] }
    : { allowedTools: input.allowedTools, bashAllowlist: input.bashAllowlist, mcpServers: input.mcpServerNames }
  const section = (title: string, text: string | undefined) => (
    <details className="mt-3">
      <summary className="cursor-pointer text-xs font-medium">{title}</summary>
      <pre className="mt-2 max-h-96 overflow-auto rounded bg-muted/40 p-3 text-xs whitespace-pre-wrap break-words">{text ?? t('Not explicitly supplied')}</pre>
    </details>
  )
  return (
    <details data-slot="agent-launch" className="my-2 rounded-lg border border-border bg-card px-3 py-2">
      <summary className="cursor-pointer text-xs font-medium">
        {t('Agent launch request')} · {input.nodeName ?? input.stepId ?? t('Node name not recorded')} · {input.backend ?? t('Unknown')} · {input.model ?? t('Backend default model')}
        <span className="mt-1 block font-normal text-muted-foreground">{t('Role skill')}: {input.skill ?? t('No role skill recorded')}</span>
      </summary>
      <div className="mt-3 space-y-2 text-xs text-muted-foreground">
        {input.stepId ? <p>{t('Node ID')}: {input.stepId}</p> : null}
        <p>{t('Captured at')}: {input.capturedAt}</p>
        <p>{t('Host launch input only; backend built-in prompts and inherited configuration are not fully exposed.')}</p>
        {input.resume ? <p>{t('Resumed session; previous conversation history is not repeated here.')}</p> : null}
        {input.truncatedFields?.length ? <p>{t('Display snapshot truncated')}: {input.truncatedFields.join(', ')}</p> : null}
        {section(t('System prompt supplied by cezar'), input.systemPrompt)}
        {section(t('User prompt supplied by cezar'), input.userPrompt)}
        {section(t('Tool configuration supplied at launch'), JSON.stringify(tools, null, 2))}
        <p>{t('Tool configuration is not a complete runtime inventory. Backend defaults, plugins and restrictions may differ; actual tool calls retain their own inputs.')}</p>
        {section(t('Launch parameters'), JSON.stringify(parameters, null, 2))}
      </div>
    </details>
  )
}
