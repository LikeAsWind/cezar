import { useRunEvents } from '@/api/run-events'
import { useMemo } from 'react'
import type { WorkflowGraphNode } from '@open-mercato/cezar-api-client'
import { ClarificationCard } from '../task-thread/clarification-card'
import { reduceThread } from '../task-thread/thread-state'

export function NodeClarifications({ runId, node }: { runId: string; node: WorkflowGraphNode }) {
  const events = useRunEvents(runId)
  const questions = useMemo(() => reduceThread(events).turns.flatMap(turn => turn.items).flatMap(entry => entry.kind === 'note' && entry.clarification ? [entry.clarification] : []), [events])
  const relevant = questions.filter(question => question.origin === node.id || (node.type === 'agent' && node.skill === 'cezar:adjudicator'))
  return relevant.length ? <div className="px-4">{relevant.map(question => <ClarificationCard key={`${question.origin}:${question.q}:${question.round}`} value={question} />)}</div> : null
}
