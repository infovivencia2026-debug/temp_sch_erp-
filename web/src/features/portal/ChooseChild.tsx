import { EmptyState, Loading } from '@/components/ui'
import { useChildren } from './use-children'

/* "Choose a child", but only once there is a list to choose from.

   Every one-child screen shows this when no child is picked, and an empty
   list read as "nobody picked" while the list was still on its way: a
   student's own screen flashed "Choose a child" and then jumped to their day.
   While the list is loading this holds the space with a skeleton instead. */
export function ChooseChild({ title, body }: { title: string; body?: string }) {
  const { query } = useChildren()
  if (query.isPending) return <Loading shape="cards" rows={3} />
  return <EmptyState title={title} body={body} />
}
