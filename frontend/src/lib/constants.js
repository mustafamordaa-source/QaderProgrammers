// Mirrors backend/app/transitions.py and the enums in backend/app/models.py.
// The server is authoritative: this exists so the UI only offers moves that
// will be accepted, not to enforce anything.

// Every status a live task can hold, in workflow order.
export const STATUSES = [
  'proposed',
  'backlog',
  'to_do',
  'in_progress',
  'in_review',
  'blocked',
  'needs_confirm',
  'done',
  'dropped',
]

// Legacy values appear only in old events. No task holds them and no move may
// target them.
export const LEGACY_STATUSES = ['in_progress_front', 'in_progress_back']

export const STATUS_LABELS = {
  proposed: 'Proposed',
  backlog: 'Backlog',
  to_do: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  blocked: 'Blocked',
  needs_confirm: 'Needs confirmation',
  done: 'Done',
  dropped: 'Dropped',
  in_progress_front: 'In progress (front)',
  in_progress_back: 'In progress (back)',
}

export const STATUS_SHORT_LABELS = {
  proposed: 'Proposed',
  backlog: 'Backlog',
  to_do: 'To do',
  in_progress: 'Working',
  in_review: 'Review',
  blocked: 'Blocked',
  needs_confirm: 'Confirm',
  done: 'Done',
  dropped: 'Dropped',
  in_progress_front: 'Front',
  in_progress_back: 'Back',
}

// Badge classes per status. Full class strings so Tailwind keeps them.
export const STATUS_STYLES = {
  proposed: 'border-series2/40 text-series2',
  backlog: 'border-hairline text-ink-muted',
  to_do: 'border-hairline text-ink-secondary',
  in_progress: 'border-series1/40 text-series1',
  in_review: 'border-series3/40 text-series3',
  blocked: 'border-critical/40 text-critical',
  needs_confirm: 'border-warning/50 text-warning',
  done: 'border-good/40 text-good',
  dropped: 'border-hairline text-ink-muted line-through',
  in_progress_front: 'border-series1/40 text-series1',
  in_progress_back: 'border-series1/40 text-series1',
}

// Board columns. "Waiting" holds both parking statuses; "Triage" is for
// leads and admins only. Dropped tasks are not shown. A drop on a column targets the
// first of its statuses that the move allows.
export const BOARD_COLUMNS = [
  { key: 'triage', label: 'Triage', statuses: ['proposed'], leadOnly: true },
  { key: 'backlog', label: 'Backlog', statuses: ['backlog'] },
  { key: 'to_do', label: 'To do', statuses: ['to_do'] },
  { key: 'in_progress', label: 'In progress', statuses: ['in_progress'] },
  { key: 'in_review', label: 'In review', statuses: ['in_review'] },
  { key: 'waiting', label: 'Waiting', statuses: ['blocked', 'needs_confirm'] },
  { key: 'done', label: 'Done', statuses: ['done'] },
]

const ALLOWED_TRANSITIONS = {
  proposed: ['backlog', 'to_do', 'dropped'],
  backlog: ['to_do', 'dropped'],
  to_do: ['in_progress', 'backlog', 'dropped'],
  in_progress: ['in_review', 'to_do', 'dropped'],
  in_review: ['done', 'in_progress', 'dropped'],
  blocked: ['dropped'],
  needs_confirm: ['dropped'],
  done: [],
  dropped: [],
}

const PARKABLE = new Set(['backlog', 'to_do', 'in_progress', 'in_review'])
const PARKING = new Set(['blocked', 'needs_confirm'])
const CLOSED = new Set(['done', 'dropped'])
const LEADER_ONLY_TARGETS = new Set(['done', 'dropped'])
const LEADER_ONLY_MOVES = new Set([
  'proposed>backlog',
  'proposed>to_do',
  'backlog>to_do',
  'to_do>backlog',
])

export function isClosed(status) {
  return CLOSED.has(status)
}

export function isParked(status) {
  return PARKING.has(status)
}

/** Every status reachable from `current`, ignoring who asks (allowed_targets). */
export function reachableTargets(current, resumeStatus) {
  if (PARKING.has(current)) {
    const targets = new Set(ALLOWED_TRANSITIONS[current])
    targets.add(resumeStatus || 'to_do')
    for (const other of PARKING) if (other !== current) targets.add(other)
    return [...targets]
  }
  const targets = new Set(ALLOWED_TRANSITIONS[current] ?? [])
  if (PARKABLE.has(current)) for (const parking of PARKING) targets.add(parking)
  return [...targets]
}

/**
 * Statuses this person may move the task to. Mirrors check_transition.
 * `isWorker` is true for assignees and for the holder of a live claim on a
 * pool task; leads and admins may move anything.
 */
export function allowedTargets(task, user, isWorker) {
  if (!task || CLOSED.has(task.status)) return []
  const targets = reachableTargets(task.status, task.resume_status)
  if (hasLeadRights(user)) return targets
  if (!hasMemberRights(user) || !isWorker) return []
  return targets.filter(
    (target) =>
      !LEADER_ONLY_TARGETS.has(target) &&
      !LEADER_ONLY_MOVES.has(`${task.status}>${target}`) &&
      !(task.status === 'in_review' && target === 'in_progress'),
  )
}

/** Moves that need a comment, so the board never makes them on a drop. */
export function moveNeedsComment(from, to) {
  return to === 'dropped' || (from === 'in_review' && to === 'in_progress')
}

/** Moves the server refuses while a criterion is open. */
export function moveNeedsCriteriaMet(to) {
  return to === 'in_review' || to === 'done'
}

function asUtcMillis(value) {
  if (!value) return NaN
  const stamp = /[Zz]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`
  return new Date(stamp).getTime()
}

/** Is the claim on this task still running? */
export function claimIsLive(task, now = Date.now()) {
  if (!task?.claimed_by || !task.claim_expires_at) return false
  return asUtcMillis(task.claim_expires_at) > now
}

/** May `user` work on (not only read) this task? Mirrors _is_worker. */
export function isWorkerOn(task, user) {
  if (!task || !user) return false
  if (hasLeadRights(user)) return true
  if (!hasMemberRights(user)) return false
  if (task.assignee_1_id === user.id || task.assignee_2_id === user.id) return true
  return Boolean(task.pool && task.claimed_by === user.id && claimIsLive(task))
}

/** May `user` claim this task now? Mirrors claim_task. */
export function canClaim(task, user) {
  if (!task || !user || isReadOnlyUser(user)) return false
  if (!['to_do', 'in_progress'].includes(task.status)) return false
  if (hasLeadRights(user)) return true
  return task.assignee_1_id === user.id || task.assignee_2_id === user.id || Boolean(task.pool)
}

// Statuses a leader may pick when creating a task. Members land in backlog.
export const CREATE_STATUSES = ['proposed', 'backlog', 'to_do']

export const SIDES = ['fe', 'be', 'mobile', 'content', 'infra', 'qa', 'design', 'other']

// "Works on" for a person. `other` is a task side only.
export const PERSON_SIDES = ['fe', 'be', 'mobile', 'content', 'infra', 'qa', 'design']

export const SIDE_LABELS = {
  fe: 'Frontend',
  be: 'Backend',
  mobile: 'Mobile',
  content: 'Content',
  infra: 'Infra',
  qa: 'QA',
  design: 'Design',
  other: 'Other',
}

// Access roles. Mirrors AccessRole in backend/app/models.py. Rights add up;
// admin includes lead rights; viewer counts only when nothing else is held.
export const ACCESS_ROLES = ['admin', 'lead', 'member', 'viewer']

export const ROLE_LABELS = {
  admin: 'Admin',
  lead: 'Lead',
  member: 'Member',
  viewer: 'Viewer',
}

export const ROLE_HINTS = {
  admin: 'Everything a lead can do, plus people, bot accounts and everyone’s tokens.',
  lead: 'Triage, assign, approve, reject and drop work; sees restricted tasks.',
  member: 'Can be assigned, claims tasks, moves and documents their own work.',
  viewer: 'Reads only. Ignored when another role is ticked.',
}

// The old single `role` column, for rows or clients that lack `roles`.
const LEGACY_ROLES = {
  leader: ['admin', 'lead'],
  programmer: ['member'],
  viewer: ['viewer'],
}

/** The person's access roles, deduplicated and ordered like the server does. */
export function rolesOf(user) {
  if (!user) return []
  const raw =
    Array.isArray(user.roles) && user.roles.length ? user.roles : LEGACY_ROLES[user.role] ?? []
  const wanted = new Set(raw)
  if ([...wanted].some((r) => r !== 'viewer')) wanted.delete('viewer')
  return ACCESS_ROLES.filter((r) => wanted.has(r))
}

export function hasAdminRights(user) {
  return rolesOf(user).includes('admin')
}

export function hasLeadRights(user) {
  const roles = rolesOf(user)
  return roles.includes('lead') || roles.includes('admin')
}

export function hasMemberRights(user) {
  return rolesOf(user).includes('member')
}

export function isReadOnlyUser(user) {
  return !hasLeadRights(user) && !hasMemberRights(user)
}

export function isBot(user) {
  return user?.account_type === 'bot'
}

/** People a task can go to: active members. Bots propose work; the UI does
 *  not offer them as assignees. */
export function assignablePeople(people) {
  return (people ?? []).filter((p) => hasMemberRights(p) && p.is_active !== false && !isBot(p))
}

// Scopes an admin may give a bot token. Mirrors BOT_SCOPES in backend/app/deps.py.
export const BOT_SCOPES = {
  'tasks:read': 'Read the tasks it can see',
  'tasks:propose': 'File proposals for a lead to triage',
  'comments:write': 'Comment on its own proposals',
}

export const COMMENT_KINDS = ['note', 'question', 'answer', 'decision', 'review', 'handback']

// Kinds offered in the top-level composer. Answers are replies to a question.
export const COMPOSER_KINDS = ['note', 'question', 'decision', 'review', 'handback']

export const COMMENT_KIND_LABELS = {
  note: 'Note',
  question: 'Question',
  answer: 'Answer',
  decision: 'Decision',
  review: 'Review',
  handback: 'Hand-back',
}

export const COMMENT_KIND_STYLES = {
  note: 'border-hairline text-ink-secondary',
  question: 'border-warning/50 text-warning',
  answer: 'border-good/40 text-good',
  decision: 'border-series1/40 text-series1',
  review: 'border-series3/40 text-series3',
  handback: 'border-series2/40 text-series2',
}

// The hand-back template. The server needs text after Summary:, Checks run:
// and Left:.
export const HANDBACK_TEMPLATE = [
  'Summary: ',
  'Branch / PR: ',
  'Commits: ',
  'Checks run: ',
  'Left: ',
  'Questions: ',
  'Deploy: ',
].join('\n')

export const HANDBACK_REQUIRED = ['Summary:', 'Checks run:', 'Left:']

/** Headings from HANDBACK_REQUIRED that have no text after them in `body`. */
export function missingHandbackHeadings(body) {
  const lines = (body || '').split('\n')
  return HANDBACK_REQUIRED.filter((heading) => {
    const line = lines.find((l) => l.trim().toLowerCase().startsWith(heading.toLowerCase()))
    return !line || !line.trim().slice(heading.length).trim()
  })
}

export const DEPLOY_STATES = ['none', 'staging', 'production']

export const DEPLOY_LABELS = {
  none: 'Not deployed',
  staging: 'On staging',
  production: 'In production',
}

export const DEPLOY_STYLES = {
  none: 'border-hairline text-ink-muted',
  staging: 'border-warning/50 text-warning',
  production: 'border-good/40 text-good',
}

export const CRITERION_LABELS = {
  open: 'Open',
  met: 'Met',
  dropped: 'Dropped',
}

export const GIT_KINDS = ['branch', 'pr', 'commit']

export const GIT_KIND_LABELS = {
  branch: 'Branch',
  pr: 'Pull request',
  commit: 'Commit',
}

export const GIT_STATES = ['open', 'merged', 'closed']

export const ACTOR_KIND_LABELS = {
  human: 'Human',
  agent: 'Agent',
  system: 'System',
}

// Task kinds. Mirrors TaskKind in backend/app/models.py; the templates for
// each come from GET /tasks/templates.
export const TASK_KINDS = ['task', 'bug', 'feature', 'chore', 'content', 'docs', 'research']

export const KIND_LABELS = {
  task: 'Task',
  bug: 'Bug',
  feature: 'Feature',
  chore: 'Chore',
  content: 'Content',
  docs: 'Docs',
  research: 'Research',
}

export const KIND_STYLES = {
  task: 'border-hairline text-ink-secondary',
  bug: 'border-critical/40 bg-critical/5 text-critical',
  feature: 'border-series1/40 text-series1',
  chore: 'border-hairline text-ink-muted',
  content: 'border-series3/40 text-series3',
  docs: 'border-series3/30 text-ink-secondary',
  research: 'border-series2/40 text-series2',
}

// Links between tasks. Mirrors LinkKind in backend/app/models.py.
export const LINK_KINDS = ['blocks', 'relates', 'duplicates']

// Read as "This task ___ #N".
export const LINK_KIND_VERBS = {
  blocks: 'blocks',
  relates: 'relates to',
  duplicates: 'duplicates',
}

/** "#3, #5" for a list of task ids. */
export function taskIdList(ids) {
  return (ids ?? []).map((id) => `#${id}`).join(', ')
}

export const INBOX_REASON_LABELS = {
  question: 'Question for you',
  blocked: 'Blocked',
  needs_confirm: 'Needs confirmation',
  review: 'Waiting for review',
  triage: 'Waiting for triage',
}

// Notification kinds. Mirrors NotifyKind in backend/app/models.py; the verbs
// match KIND_TEXT in backend/app/mailer.py so the bell and the email agree.
export const NOTIFY_KIND_LABELS = {
  assigned: 'Assigned',
  question: 'Question',
  answered: 'Answered',
  mention: 'Mention',
  review: 'Review',
  rejected: 'Sent back',
  approved: 'Approved',
  proposal: 'Proposal',
}

export const NOTIFY_KIND_VERBS = {
  assigned: 'assigned you',
  question: 'asked you a question',
  answered: 'answered your question',
  mention: 'mentioned you',
  review: 'sent work for review',
  rejected: 'sent your work back',
  approved: 'approved your work',
  proposal: 'proposed a task',
}

// Settings checkboxes: what each email kind means to the reader.
export const NOTIFY_KIND_PREF_LABELS = {
  assigned: 'Assigned to me',
  question: 'Asked me a question',
  answered: 'My question answered',
  mention: 'Mentioned me',
  review: 'Work waiting for review (leads)',
  rejected: 'My work sent back',
  approved: 'My work approved',
  proposal: 'New proposals (leads)',
}

export const NOTIFY_KIND_STYLES = {
  assigned: 'border-series1/40 text-series1',
  question: 'border-warning/50 text-warning',
  answered: 'border-good/40 text-good',
  mention: 'border-series2/40 text-series2',
  review: 'border-series3/40 text-series3',
  rejected: 'border-critical/40 text-critical',
  approved: 'border-good/40 text-good',
  proposal: 'border-series2/40 text-series2',
}

// The most an API token may live. Mirrors settings.api_token_max_days.
export const TOKEN_MAX_DAYS = 90

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
  created: 'created the task',
  status_changed: 'moved it',
  rejected: 'sent it back',
  approved: 'approved it',
  closed: 'closed it',
  claimed: 'claimed it',
  released: 'released the claim',
  assigned: 'reassigned it',
  field_changed: 'edited it',
  commented: 'commented',
  question_asked: 'asked a question',
  question_answered: 'closed a question',
  criterion_added: 'added a criterion',
  criterion_changed: 'changed a criterion',
  git_linked: 'linked git work',
  deployed: 'changed the deploy state',
  dropped: 'dropped it',
  triaged: 'triaged it',
  doc_saved: 'saved a document',
  file_added: 'attached a file',
  file_removed: 'removed a file',
  context_added: 'added a context link',
  context_removed: 'removed a context link',
  linked: 'linked a task',
  unlinked: 'removed a task link',
  seen_again: 'filed it again',
}

// Documents. Mirrors DocKind in backend/app/models.py.
export const DOC_KINDS = ['spec', 'plan', 'notes', 'test_plan', 'decision', 'handover', 'other']

export const DOC_KIND_LABELS = {
  spec: 'Spec',
  plan: 'Plan',
  notes: 'Notes',
  test_plan: 'Test plan',
  decision: 'Decision',
  handover: 'Hand-over',
  other: 'Other',
}

// Attachments. Mirrors ALLOWED_FILES and file_max_mb in backend/app/routers/docs.py.
export const FILE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.txt', '.md', '.csv', '.json', '.log']
export const FILE_MAX_MB = 10
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

export const LIBRARY_KIND_LABELS = {
  hub_doc: 'Hub document',
  repo_path: 'Repo file',
  url: 'Web page',
}

/** https://github.com/{repo}/blob/{ref or HEAD}/{path}, each part encoded. */
export function githubBlobUrl(repo, ref, path) {
  if (!repo || !path || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null
  const cleanPath = path.split('/').filter(Boolean).map(encodeURIComponent).join('/')
  const cleanRef = (ref || 'HEAD').split('/').map(encodeURIComponent).join('/')
  return `https://github.com/${repo}/blob/${cleanRef}/${cleanPath}`
}

/** Only https links leave the app. */
export function safeHttpsUrl(url) {
  if (typeof url !== 'string') return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}

export function formatBytes(size) {
  if (size === null || size === undefined) return '—'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

/** Split "a, b\nc" into a clean list without repeats. */
export function splitList(text) {
  const out = []
  for (const part of (text || '').split(/[\n,]/)) {
    const value = part.trim()
    if (value && !out.includes(value)) out.push(value)
  }
  return out
}
