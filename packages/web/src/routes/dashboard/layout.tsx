import { t, useLocale } from '@/lib/i18n'
import type { ReactNode } from 'react'
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import { GripHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { TileId } from './preferences'

const names: Record<TileId, string> = {
  overview: 'Workspace overview',
  portfolio: 'Projects',
  automations: 'Automations',
  fleet: 'Queue & scheduling',
  needsYou: 'Needs you',
  recent: 'Recent results & GitHub',
  usage: 'Usage & cost',
  trends: 'Trends',
}
function Module({ id, children, wide }: { id: TileId; children: ReactNode; wide: boolean }) {
  useLocale()

  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } =
    useSortable({ id })
  return (
    <section
      ref={setNodeRef}
      data-dashboard-module={id}
      className={`group/module relative min-w-0 ${wide ? 'lg:col-span-2' : ''} ${isDragging ? 'z-20 opacity-80' : ''}`}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
      }}
    >
      {/* The handle straddles the card's top edge instead of owning a row of its own: a
          full-width row per module was most of the dashboard's vertical whitespace. The
          button keeps its 44px target; only the pill inside it is visible. */}
      <Button
        ref={setActivatorNodeRef}
        variant="ghost"
        className="absolute -top-[22px] left-1/2 z-10 min-h-11 min-w-11 -translate-x-1/2 cursor-grab touch-none p-0 opacity-0 transition-opacity hover:bg-transparent focus-visible:opacity-100 active:cursor-grabbing group-hover/module:opacity-100 no-hover:opacity-100"
        {...attributes}
        {...listeners}
        aria-label={t('Move {0}', { 0: t(names[id]) })}
      >
        <span className="flex h-4 w-8 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-xs">
          <GripHorizontal className="size-3.5" aria-hidden="true" />
        </span>
      </Button>
      {children}
    </section>
  )
}
export function DashboardLayout({
  order,
  modules,
  onOrder,
}: {
  order: TileId[]
  modules: Partial<Record<TileId, ReactNode>>
  onOrder: (order: TileId[]) => void
}) {
  useLocale()

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const visible = order.filter((id) => modules[id])
  const wide = new Set<TileId>(['overview', 'portfolio', 'usage', 'trends'])
  // Pair consecutive compact modules in DOM order. A leftover card fills its row;
  // dense grid packing would make visual order disagree with keyboard/drag order.
  let unpaired: TileId | undefined
  for (const id of visible) {
    if (wide.has(id)) {
      if (unpaired) wide.add(unpaired)
      unpaired = undefined
    } else if (unpaired) unpaired = undefined
    else unpaired = id
  }
  if (unpaired) wide.add(unpaired)
  const describe = (id: string | number) =>
    t('{0}, position {1} of {2}', { 0: t(names[id as TileId]), 1: visible.indexOf(id as TileId) + 1, 2: visible.length })
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      accessibility={{
        announcements: {
          onDragStart: ({ active }) => t('Picked up {0}.', { 0: describe(active.id) }),
          onDragOver: ({ active, over }) =>
            over
              ? t('{0} moved to position {1} of {2}.', { 0: t(names[active.id as TileId]), 1: visible.indexOf(over.id as TileId) + 1, 2: visible.length })
              : undefined,
          onDragEnd: ({ active, over }) =>
            over
              ? t('{0} dropped at position {1} of {2}.', { 0: t(names[active.id as TileId]), 1: visible.indexOf(over.id as TileId) + 1, 2: visible.length })
              : t('Order unchanged. {0}.', { 0: describe(active.id) }),
          onDragCancel: ({ active }) => t('Reordering cancelled. {0}.', { 0: describe(active.id) }),
        },
        screenReaderInstructions: {
          draggable:
            t('Press Space to pick up a module, use arrow keys to move, Space to drop, or Escape to cancel.'),
        },
      }}
      onDragEnd={({ active, over }) => {
        if (!over || active.id === over.id) return
        onOrder(
          arrayMove(
            order,
            order.indexOf(active.id as TileId),
            order.indexOf(over.id as TileId),
          ),
        )
      }}
    >
      <SortableContext items={visible} strategy={rectSortingStrategy}>
        <div className="grid items-start gap-5 lg:grid-cols-2">
          {visible.map((id) => (
            <Module key={id} id={id} wide={wide.has(id)}>
              {modules[id]}
            </Module>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
}
