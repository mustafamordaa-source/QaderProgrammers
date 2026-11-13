import {
  SIDES,
  SIDE_LABELS,
  STATUS_LABELS,
  allowedTargets,
  claimIsLive,
  hasLeadRights,
  isWorkerOn,
  moveNeedsComment,
  moveNeedsCriteriaMet,
  reachableTargets,
} from '../../lib/constants'

// One column is 300px wide with a 12px gap (Tailwind gap-3). The scroller steps
// by this much, so keep the numbers and the classes in step.
export const COLUMN_WIDTH = 300
export const COLUMN_GAP = 12
export const COLUMN_STEP = COLUMN_WIDTH + COLUMN_GAP

// Done can hold hundreds of cards; the board shows the latest ones first.
export const DONE_PAGE = 20

/** Is this task assigned to `user`, or held by a live claim of theirs? */
export function isMine(task, user) {
  if (!task || !user) return false
  if (task.assignee_1_id === user.id || task.assignee_2_id === user.id) return true
  return task.claimed_by === user.id && claimIsLive(task)
}

export function targetsFor(task, user) {
  return allowedTargets(task, user, isWorkerOn(task, user))
}

/** The status a drop on `column` would move `task` to, or null. Moves that
 *  need a comment (drop, send back) or open criteria stay in the detail view. */
export function dropTarget(column, task, targets) {
  if (!task || column.statuses.includes(task.status)) return null
  return (
    column.statuses.find(
      (status) =>
        targets.includes(status) &&
        !moveNeedsComment(task.status, status) &&
        !(moveNeedsCriteriaMet(status) && task.criteria_open > 0),
    ) ?? null
  )
}

/** One short line on why `task` cannot be dropped on `column`, or null. */
export function dropBlockReason(column, task, targets, user) {
  if (!task || column.statuses.includes(task.status)) return null
  if (dropTarget(column, task, targets)) return null
  const to = column.label
  if (targets.length === 0) {
    if (task.status === 'done') return 'Done tasks stay in Done.'
    return 'Only the assignees, the person holding the claim or a lead can move this task.'
  }
  const legal = column.statuses.filter((status) => targets.includes(status))
  if (legal.some((status) => moveNeedsComment(task.status, status))) {
    return `Moving it to ${to} needs a comment. Open the task and do it there.`
  }
  if (legal.some((status) => moveNeedsCriteriaMet(status)) && task.criteria_open > 0) {
    const n = task.criteria_open
    return `Close its ${n} open acceptance criteri${n === 1 ? 'on' : 'a'} before ${to}.`
  }
  const reachable = reachableTargets(task.status, task.resume_status)
  if (!hasLeadRights(user) && column.statuses.some((status) => reachable.includes(status))) {
    return `Only a lead can move it to ${to}.`
  }
  return `${STATUS_LABELS[task.status] ?? task.status} tasks cannot go straight to ${to}.`
}

/** Done, newest change first. */
export function sortDone(list) {
  return [...list].sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')))
}

/**
 * Swimlanes for `groupBy` ('side' or 'assignee'), in a stable order: sides in
 * their usual order, people with "you" first and then by name, unassigned last.
 * Shared tasks sit in the lane of their first assignee.
 */
export function buildLanes(tasks, groupBy, user) {
  if (groupBy === 'side') {
    const lanes = [...SIDES.map((side) => ({ key: side, label: SIDE_LABELS[side] })), { key: '', label: 'No side' }]
    return lanes
      .map((lane) => ({ ...lane, tasks: tasks.filter((task) => (task.side || '') === lane.key) }))
      .filter((lane) => lane.tasks.length > 0)
  }
  if (groupBy === 'assignee') {
    const lanes = new Map()
    for (const task of tasks) {
      const person = task.assignee_1
      const key = person ? String(person.id) : ''
      if (!lanes.has(key)) {
        lanes.set(key, {
          key,
          label: person ? person.name : 'Unassigned',
          me: Boolean(person && user && person.id === user.id),
          tasks: [],
        })
      }
      lanes.get(key).tasks.push(task)
    }
    return [...lanes.values()].sort((a, b) => {
      if (a.key === '' || b.key === '') return a.key === '' ? 1 : -1
      if (a.me !== b.me) return a.me ? -1 : 1
      return a.label.localeCompare(b.label)
    })
  }
  return [{ key: 'all', label: '', tasks }]
}

const EMPTY_LINES = {
  triage: 'No proposals waiting. Agents and members file them here.',
  backlog: 'Backlog is empty. New ideas from members land here first.',
  to_do: 'Nothing ready. Create a task or accept proposals in Triage.',
  in_progress: 'Nobody is on a task right now. Pick one from To do.',
  in_review: 'Nothing waits for review.',
  waiting: 'No blocked tasks and nothing waiting for confirmation.',
  done: 'Finished tasks show up here.',
}

export function emptyLine(columnKey, { filtered, isLead }) {
  if (filtered) return 'No matches for these filters.'
  if (columnKey === 'to_do' && !isLead) return 'Nothing ready. Create a task, or ask a lead to plan more work.'
  return EMPTY_LINES[columnKey] ?? 'Nothing here.'
}
