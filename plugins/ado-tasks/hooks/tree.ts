import type { PullRequestRow, TaskRow, TreeLine } from '../types'

/** One line of the pull request list: a repository, or one of its PRs with its tree guide. */
export type PullRequestLine = { kind: 'repo'; repo: string; count: number } | { kind: 'pr'; row: PullRequestRow; prefix: string }

/** The PRs under their repository, in the rows' order (repository by name, newest PR first). */
export function buildPullRequestLines(rows: readonly PullRequestRow[]): PullRequestLine[] {
  const byRepo = new Map<string, PullRequestRow[]>()
  for (const row of rows) byRepo.set(row.repo, [...(byRepo.get(row.repo) ?? []), row])

  return [...byRepo].flatMap(([repo, prs]): PullRequestLine[] => [
    { kind: 'repo', repo, count: prs.length },
    ...prs.map((row, index): PullRequestLine => ({ kind: 'pr', row, prefix: index === prs.length - 1 ? '└─ ' : '├─ ' })),
  ])
}

/*
 * Pure layout of the parent/child hierarchy the pane draws: no `$`, no Azure DevOps calls.
 */

type Node = { row: TaskRow; isContext: boolean; children: Node[]; rank: number }

/**
 * The rows as a forest in drawing order, each line with its tree guides.
 *
 * A row whose parent is among the rows or the ancestors is drawn under it; any other
 * row is a root. Siblings and roots keep the order of the earliest matching row they
 * hold, so the list's own order (newest change first) still leads.
 */
export function buildTree(tasks: readonly TaskRow[], ancestors: readonly TaskRow[]): TreeLine[] {
  const nodes = new Map<number, Node>()
  tasks.forEach((row, index) => nodes.set(row.id, { row, isContext: false, children: [], rank: index }))
  for (const row of ancestors) {
    if (!nodes.has(row.id)) nodes.set(row.id, { row, isContext: true, children: [], rank: Number.POSITIVE_INFINITY })
  }

  const roots: Node[] = []
  for (const node of nodes.values()) {
    const parent = node.row.parentId === undefined ? undefined : nodes.get(node.row.parentId)
    if (parent === undefined || createsCycle(nodes, node)) roots.push(node)
    else parent.children.push(node)
  }

  const rankOf = (node: Node): number => {
    for (const child of node.children) node.rank = Math.min(node.rank, rankOf(child))
    return node.rank
  }
  roots.forEach(rankOf)

  const lines: TreeLine[] = []
  const emit = (siblings: Node[], guide: string, isRoot: boolean) => {
    const ordered = siblings.filter(node => node.rank !== Number.POSITIVE_INFINITY).sort((a, b) => a.rank - b.rank)
    ordered.forEach((node, index) => {
      const isLast = index === ordered.length - 1
      lines.push({ row: node.row, isContext: node.isContext, prefix: isRoot ? '' : `${guide}${isLast ? '└─ ' : '├─ '}` })
      emit(node.children, isRoot ? '' : `${guide}${isLast ? '   ' : '│  '}`, false)
    })
  }
  emit(roots, '', true)

  return lines
}

/** True when walking up from `node` comes back to it: such a link is drawn as a root. */
function createsCycle(nodes: Map<number, Node>, node: Node): boolean {
  const seen = new Set<number>([node.row.id])
  let parentId = node.row.parentId
  while (parentId !== undefined) {
    if (seen.has(parentId)) return true
    seen.add(parentId)
    parentId = nodes.get(parentId)?.row.parentId
  }

  return false
}
