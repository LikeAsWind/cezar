import type { WorkflowClarification } from '@open-mercato/cezar-api-client'
import { MessageCircleQuestionIcon, LoaderCircleIcon, CheckCircle2Icon, CircleAlertIcon } from 'lucide-react'
import { useParams } from 'react-router'
import { Link } from '@/lib/project-router'
import { t, useLocale } from '@/lib/i18n'
import { Markdown } from './markdown'

const labels = { pending: 'Awaiting adjudication', answering: 'Adjudicator is answering', answered: 'Adjudication answered', blocked: 'Human confirmation required', failed: 'Adjudication failed' } as const
export function ClarificationCard({ value }: { value: WorkflowClarification }) {
  useLocale()
  const { id } = useParams<{ id: string }>()
  const answer = value.answer?.trim()
  const Icon = value.status === 'answering' ? LoaderCircleIcon : value.status === 'answered' ? CheckCircle2Icon : (value.status === 'blocked' || value.status === 'failed') ? CircleAlertIcon : MessageCircleQuestionIcon
  const highlights = value.answer?.split('\n').flatMap(line => {
    const match = /^\s*(?:#{1,6}\s*)?(?:\*\*)?(回答|结论|依据|影响|取舍)(?:\*\*)?[：:]\s*(.+)$/.exec(line)
    return match ? [{ label: match[1]!, text: match[2]! }] : []
  }) ?? []
  // Keep original text when the role did not supply labelled fields; never invent a summary.
  const question = value.question.replace(/\s*CEZ:VERDICT[^\n]*$/, '').replace(/^origin:.*$/gm, '').trim()
  const questionSection = /(?:^|\n)(?:#{1,6}\s*|\*\*)?(?:需要裁决|待裁决|问题)[^\n]*\n([\s\S]*?)(?=\norigin:|$)/.exec(question)?.[1]?.trim()
  return (
    <article data-slot="clarification-card" className="my-3 overflow-hidden rounded-lg border border-border bg-card shadow-xs">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium"><Icon aria-hidden="true" className={`size-4 ${value.status === 'answering' ? 'motion-safe:animate-spin text-primary' : value.status === 'failed' ? 'text-danger' : value.status === 'blocked' ? 'text-pending' : 'text-primary'}`} />{t('Adjudicator')}<span className="font-mono text-xs text-muted-foreground">{value.q}</span></div>
        <span role="status" className="text-xs text-muted-foreground">{t(labels[value.status])} · {t('Round {0}', { 0: value.round })}</span>
      </header>
      <div className="space-y-3 px-4 py-3 text-sm">
        <section aria-label={`${value.originName} · ${t('Assistant question')}`} className="space-y-2">
          <p className="flex flex-wrap items-center gap-2 text-xs"><span className="font-medium">{value.originName}</span><span className="text-muted-foreground">{t('Assistant question')}</span></p>
          <Markdown breaks>{questionSection || question}</Markdown>
          {questionSection || question !== value.question ? <details><summary className="cursor-pointer text-xs text-muted-foreground">{t('Full question and context')}</summary><Markdown breaks>{value.question}</Markdown></details> : null}
        </section>
        <section aria-label={`${t('Adjudicator')} · ${t('Assistant answer')}`} className="space-y-2 border-t border-border pt-3">
          <p className="flex flex-wrap items-center gap-2 text-xs"><span className="font-medium">{t('Adjudicator')}</span><span className="text-muted-foreground">{t('Assistant answer')}</span></p>
          {answer ? <>
            {highlights.length ? highlights.map((field, index) => <div key={index}><span className="text-xs font-medium text-muted-foreground">{field.label}</span><Markdown breaks>{field.text}</Markdown></div>) : <Markdown breaks>{answer}</Markdown>}
            <details><summary className="cursor-pointer text-xs text-muted-foreground">{t('Full answer and evidence')}</summary><div className="mt-2"><Markdown breaks>{value.answer ?? ''}</Markdown></div></details>
          </> : <p className="text-xs text-muted-foreground">{t(value.status === 'answering' ? 'The answer will appear here when adjudication finishes.' : value.status === 'pending' ? 'Waiting for the workflow to invoke the adjudicator.' : 'No adjudicator answer was recorded.')}</p>}
        </section>
        {value.status === 'answered' && answer ? <p className="text-xs text-primary">{t('Decision recorded; the originating node will continue.')}</p> : null}
        {id ? <Link className="inline-flex text-xs text-primary hover:underline" to={`/tasks/${id}/graph?node=${encodeURIComponent(value.origin)}`}>{t('View originating node')}</Link> : null}
      </div>
    </article>
  )
}
