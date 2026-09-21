// Mirrors app/transitions.py. The server is authoritative — this exists so the
// UI only offers moves that will actually be accepted, not to enforce anything.
export const STATUSES = [
  'to_do',
  'in_progress_front',
  'in_progress_back',
  'in_review',
  'done',
]

export const STATUS_LABELS = {
  to_do: 'To Do',
  in_progress_front: 'In Progress (Front)',
  in_progress_back: 'In Progress (Back)',
  in_review: 'In Review',
  done: 'Done',
}

export const STATUS_SHORT_LABELS = {
  to_do: 'To Do',
  in_progress_front: 'Front',
  in_progress_back: 'Back',
  in_review: 'Review',
  done: 'Done',
}

const ALLOWED_TRANSITIONS = {
  to_do: ['in_progress_front', 'in_progress_back'],
  in_progress_front: ['in_progress_back', 'in_review'],
  in_progress_back: ['in_progress_front', 'in_review'],
  in_review: ['done', 'in_progress_front', 'in_progress_back'],
  done: [],
}

const LEADER_ONLY_TARGETS = new Set(['done'])

/** Statuses `role` may move a task to from `current`. */
export function allowedTargets(current, role) {
  const targets = ALLOWED_TRANSITIONS[current] ?? []
  if (role === 'leader') return targets
  // Programmers can neither complete a task nor pull one back out of review.
  return targets.filter(
    (target) => !LEADER_ONLY_TARGETS.has(target) && current !== 'in_review',
  )
}

// Difficulty, set by the leader. Mirrors POINT_VALUES in backend/app/models.py
// — a Fibonacci scale, so the gaps widen and nobody argues over a 6 vs a 7.
// This is effort, not urgency; `priority` is the urgency axis.
export const POINT_VALUES = [1, 2, 3, 5, 8, 13]
export const DEFAULT_POINTS = 3

export const POINT_LABELS = {
  1: 'Trivial',
  2: 'Easy',
  3: 'Moderate',
  5: 'Hard',
  8: 'Very hard',
  13: 'Huge',
}

export const PRIORITIES = ['low', 'medium', 'high', 'urgent']

export const PRIORITY_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
}

export const EVENT_LABELS = {
  created: 'created',
  status_changed: 'moved',
  rejected: 'sent back',
  approved: 'approved',
  closed: 'closed',
}
