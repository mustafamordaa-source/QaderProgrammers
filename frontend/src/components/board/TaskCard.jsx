import {
  ActorBadge,
  BlockedBadge,
  DeployBadge,
  KindBadge,
  OverdueBadge,
  PointsBadge,
  PriorityBadge,
  SideBadge,
  StatusBadge,
} from '../Badges'
import {
  DEPLOY_LABELS,
  KIND_LABELS,
  PRIORITY_LABELS,
  QUIET_CLAIM_BLOCKS,
  SIDE_LABELS,
  STATUS_SHORT_LABELS,
  claimIsLive,
  claimableNow,
  groupPeople,
  personRoleText,
  taskKey,
} from '../../lib/constants'
import { formatDate, formatDateTime, initials, isOverdue } from '../../lib/format'
import {
  AgentIcon,
  BlockedIcon,
  CheckIcon,
  ClaimIcon,
  ClockIcon,
  DeployIcon,
  HandIcon,
  LockIcon,
  OpenIcon,
  PartIcon,
  QuestionIcon,
  SubtasksIcon,
} from './BoardIcons'
import { isMine } from './boardLayout'

// The leading edge carries the priority; the badge or a screen-reader line
// carries it in words, so colour is never the only signal.
const PRIORITY_EDGE = {
  low: 'border-s-baseline',
  medium: 'border-s-series1/50',
  high: 'border-s-serious',
  urgent: 'border-s-critical',
}

function Avatar({ person, me }) {
  return (
    <span
      title={person.name}
      dir="auto"
      className={`grid h-5 w-5 place-items-center rounded-full text-[9px] font-semibold ${
        me ? 'bg-series1 text-white' : 'bg-surface-raised text-ink-secondary ring-1 ring-hairline'
      }`}
    >
      {initials(person.name)}
    </span>
  )
}

function Assignees({ task, user, compact = false }) {
  const people = [task.assignee_1, task.assignee_2].filter(Boolean)
  if (people.length === 0) {
    return <span className="text-[11px] text-ink-muted">{task.pool ? 'Pool' : 'Unassigned'}</span>
  }
  return (
    <span className="flex items-center gap-1.5">
      <span className="flex -space-x-1">
        {people.map((person) => (
          <Avatar key={person.id} person={person} me={person.id === user?.id} />
        ))}
      </span>
      <span className="sr-only">Assigned to {people.map((p) => p.name).join(' and ')}</span>
      {!compact && people.length === 2 && <span className="text-[11px] text-ink-muted">shared</span>}
      {!compact && task.pool && <span className="text-[11px] text-ink-muted">· pool</span>}
    </span>
  )
}

/**
 * Everyone on the task, subtask parts included (`task.people`): up to three
 * avatars and "+n". Falls back to the assignees for answers without `people`.
 */
function People({ task, user, compact = false }) {
  const people = groupPeople(task.people)
  if (people.length === 0) return <Assignees task={task} user={user} compact={compact} />
  const shown = people.slice(0, 3)
  const extra = people.length - shown.length
  const describe = (person) =>
    `${person.name}${person.handle ? ` (@${person.handle})` : ''}: ${person.entries
      .map((entry) => personRoleText(entry, task.id))
      .join(', ')}`
  return (
    <span className="flex items-center gap-1.5" title={people.map(describe).join('\n')}>
      <span className="flex -space-x-1">
        {shown.map((person) => (
          <Avatar key={person.handle || person.name} person={person} me={Boolean(user?.handle) && person.handle === user.handle} />
        ))}
        {extra > 0 && (
          <span className="tabular grid h-5 min-w-5 place-items-center rounded-full bg-surface-raised px-1 text-[9px] font-semibold text-ink-secondary ring-1 ring-hairline">
            +{extra}
          </span>
        )}
      </span>
      <span className="sr-only">On this task: {people.map(describe).join('; ')}</span>
    </span>
  )
}

/** Why the viewer cannot claim this task, as a small icon with the reason as its tooltip. */
function ClaimBlock({ task, compact = false }) {
  if (!task.claim_block_text || QUIET_CLAIM_BLOCKS.has(task.claim_block)) return null
  const Glyph = task.claim_block === 'claimed' || task.claim_block === 'parts_taken' ? ClaimIcon : task.claim_block === 'waiting_decision' ? QuestionIcon : LockIcon
  return (
    <span
      title={task.claim_block_text}
      className="inline-flex shrink-0 items-center gap-1 text-[11px] text-ink-muted"
    >
      <Glyph className="h-3 w-3" />
      {/* A claim already shows its holder on the card, so only the icon here. */}
      {compact || task.claim_block === 'claimed' ? (
        <span className="sr-only">{task.claim_block_text}</span>
      ) : (
        <span className="max-w-[10rem] truncate">{task.claim_block_text}</span>
      )}
    </span>
  )
}

const LANE_LABELS = { planned: 'Planned', backlog: 'Backlog' }

function ClaimBadge({ task }) {
  if (!claimIsLive(task)) return null
  const who = task.claimer?.handle || task.claimer?.name || 'someone'
  return (
    <span
      title={`Claimed until ${formatDateTime(task.claim_expires_at)}`}
      dir="auto"
      className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-series1/40 px-2 py-0.5 text-[11px] font-medium text-series1"
    >
      <ClaimIcon className="h-3 w-3" />
      <span className="truncate">
        {who}
        {task.claim_agent ? ` / ${task.claim_agent}` : ''}
      </span>
      <span className="shrink-0 font-normal text-ink-muted">until {formatDateTime(task.claim_expires_at)}</span>
    </span>
  )
}

function CountChip({ title, tone = 'muted', children }) {
  const tones = {
    muted: 'border-hairline text-ink-secondary',
    good: 'border-good/40 text-good',
    warning: 'border-warning/50 text-warning',
  }
  return (
    <span
      title={title}
      className={`tabular inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  )
}

/** A tiny icon with an optional number, for compact cards. */
function MiniIcon({ icon: Glyph, label, className = 'text-ink-muted', children }) {
  return (
    <span title={label} className={`tabular inline-flex items-center gap-0.5 text-[11px] ${className}`}>
      <Glyph className="h-3 w-3" />
      {children}
      <span className="sr-only">{label}</span>
    </span>
  )
}

function CompactIcons({ task, overdue }) {
  const met = (task.criteria_total ?? 0) - (task.criteria_open ?? 0)
  const blockers = task.blocked_by ?? []
  return (
    <>
      {blockers.length > 0 && (
        <MiniIcon
          icon={BlockedIcon}
          label={`Blocked by open task ${blockers.map((id) => `#${id}`).join(', ')}`}
          className="text-critical"
        />
      )}
      {overdue && <MiniIcon icon={ClockIcon} label="Overdue" className="text-critical" />}
      {task.children_total > 0 && (
        <MiniIcon
          icon={SubtasksIcon}
          label={`${task.children_total - task.children_open} of ${task.children_total} subtasks closed`}
          className={task.children_open === 0 ? 'text-good' : 'text-ink-muted'}
        >
          {task.children_total - task.children_open}/{task.children_total}
        </MiniIcon>
      )}
      {task.criteria_total > 0 && (
        <MiniIcon
          icon={CheckIcon}
          label={`${met} of ${task.criteria_total} acceptance criteria met`}
          className={task.criteria_open === 0 ? 'text-good' : 'text-ink-muted'}
        >
          {met}/{task.criteria_total}
        </MiniIcon>
      )}
      {task.open_questions > 0 && (
        <MiniIcon
          icon={QuestionIcon}
          label={`${task.open_questions} open question${task.open_questions === 1 ? '' : 's'}`}
          className="text-warning"
        >
          {task.open_questions}
        </MiniIcon>
      )}
      {task.created_kind === 'agent' && (
        <MiniIcon
          icon={AgentIcon}
          label={`Filed by an agent${task.created_agent ? `: ${task.created_agent}` : ''}`}
          className="text-series2"
        />
      )}
      {task.deploy_state && task.deploy_state !== 'none' && (
        <MiniIcon
          icon={DeployIcon}
          label={DEPLOY_LABELS[task.deploy_state] ?? task.deploy_state}
          className={task.deploy_state === 'production' ? 'text-good' : 'text-warning'}
        />
      )}
      {claimIsLive(task) && (
        <MiniIcon
          icon={ClaimIcon}
          label={`Claimed by ${task.claimer?.handle || task.claimer?.name || 'someone'} until ${formatDateTime(task.claim_expires_at)}`}
          className="text-series1"
        />
      )}
      {task.parts_total > 0 && (
        <MiniIcon
          icon={PartIcon}
          label={`${task.parts_taken ?? 0} of ${task.parts_total} parts taken`}
          className={task.parts_taken >= task.parts_total ? 'text-good' : 'text-ink-muted'}
        >
          {task.parts_taken ?? 0}/{task.parts_total}
        </MiniIcon>
      )}
      {task.restricted && <MiniIcon icon={LockIcon} label="Restricted" />}
    </>
  )
}

const quickButton =
  'inline-flex items-center gap-1 rounded-md border border-hairline bg-surface px-1.5 py-0.5 text-[11px] font-medium text-ink-secondary transition hover:border-series1/50 hover:text-ink disabled:opacity-60'

/**
 * One task on the board. The whole card opens the task on click, Enter or
 * Space. Open and Claim sit in a small bar that shows on hover and keyboard
 * focus, and stays on for touch screens. `onSelect` adds a checkbox for bulk
 * triage.
 */
export default function TaskCard({
  task,
  user,
  density = 'comfortable',
  onOpen,
  onDragStart,
  onDragEnd,
  draggable,
  showStatus = false,
  selected = false,
  onSelect = null,
  onClaim = null,
  claiming = false,
  showLane = false,
}) {
  const overdue = isOverdue(task.due_date, task.status)
  const met = (task.criteria_total ?? 0) - (task.criteria_open ?? 0)
  const mine = isMine(task, user)
  const compact = density === 'compact'
  // Your own claim renews from the detail view; the card offers Take to others.
  const claimable = Boolean(onClaim) && claimableNow(task, user) && !mine
  const lane = showLane && LANE_LABELS[task.lane]

  function handleClick(event) {
    if (event.target.closest('button, input, a, label')) return
    onOpen(task)
  }

  function handleKeyDown(event) {
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onOpen(task)
    }
  }

  // Take stays visible; a task nobody can start shows why instead.
  const take = claimable ? (
    <button
      type="button"
      disabled={claiming}
      onClick={() => onClaim(task)}
      aria-label={`Take task ${taskKey(task.id)}`}
      title={
        task.status === 'backlog' || task.status === 'to_do'
          ? 'Claim this task: it moves to In progress and is yours'
          : 'Claim this task'
      }
      className={`${quickButton} border-series1/50 text-series1`}
    >
      <HandIcon className="h-3 w-3" />
      {claiming ? 'Taking…' : 'Take'}
    </button>
  ) : onClaim && !mine ? (
    <ClaimBlock task={task} compact={compact} />
  ) : null

  const actions = (
    <span className="flex shrink-0 items-center gap-1 opacity-0 transition group-hover:opacity-100 group-focus:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
      <button
        type="button"
        onClick={() => onOpen(task)}
        aria-label={`Open task #${task.id}`}
        title="Open task"
        className={quickButton}
      >
        <OpenIcon className="h-3 w-3" />
        {!compact && 'Open'}
      </button>
    </span>
  )

  return (
    <article
      data-card
      tabIndex={0}
      aria-label={`Task #${task.id}: ${task.title}`}
      draggable={draggable}
      onDragStart={(event) => onDragStart?.(event, task)}
      onDragEnd={onDragEnd}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={[
        'group relative cursor-pointer rounded-lg border border-s-[3px] text-left shadow-sm transition hover:shadow-md',
        PRIORITY_EDGE[task.priority] ?? PRIORITY_EDGE.medium,
        selected ? 'border-series1 ring-1 ring-series1' : 'border-hairline hover:border-series1/40',
        mine ? 'bg-series1/[0.05]' : 'bg-surface',
        compact ? 'px-2.5 py-2' : 'p-3',
        draggable ? 'active:cursor-grabbing' : '',
      ].join(' ')}
    >
      <span className="sr-only">
        Priority {PRIORITY_LABELS[task.priority] ?? task.priority}.{mine ? ' Yours.' : ''}
      </span>

      <div className="flex items-start gap-2">
        {onSelect && (
          <input
            type="checkbox"
            checked={selected}
            onChange={(event) => onSelect(task, event.target.checked)}
            aria-label={`Select task #${task.id} for triage`}
            className="mt-0.5 shrink-0"
          />
        )}
        <h3
          dir="auto"
          className={`min-w-0 flex-1 break-words font-medium leading-snug ${
            compact ? 'line-clamp-2 text-[13px]' : 'line-clamp-3 text-sm'
          }`}
        >
          {task.title}
        </h3>
        {mine && (
          <span className="shrink-0 rounded-full bg-series1/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-series1">
            You
          </span>
        )}
      </div>

      {compact ? (
        <div className="mt-1.5 flex items-center gap-2">
          <span className="tabular text-[11px] text-ink-muted">{taskKey(task.id)}</span>
          {lane && <span className="text-[11px] text-ink-muted">{lane}</span>}
          {showStatus && (
            <span className="text-[11px] text-ink-secondary">{STATUS_SHORT_LABELS[task.status] ?? task.status}</span>
          )}
          {task.kind && task.kind !== 'task' && (
            <span className="text-[11px] font-medium text-ink-secondary">{KIND_LABELS[task.kind] ?? task.kind}</span>
          )}
          {task.side && <span className="text-[11px] text-ink-muted">{SIDE_LABELS[task.side] ?? task.side}</span>}
          {task.area && <span dir="auto" className="text-[11px] text-series2">{task.area.name}</span>}
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            <CompactIcons task={task} overdue={overdue} />
          </span>
          {take}
          {actions}
          <People task={task} user={user} compact />
        </div>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="tabular me-0.5 text-[11px] text-ink-muted">
              {taskKey(task.id)}
              {task.parent_id && (
                <span className="ms-1" title={`Subtask of ${taskKey(task.parent_id)}`}>
                  ↳ {taskKey(task.parent_id)}
                </span>
              )}
            </span>
            {lane && (
              <span
                title={task.lane === 'planned' ? 'Planned: in To do, take it first' : 'In the backlog'}
                className="text-[11px] text-ink-muted"
              >
                {lane}
              </span>
            )}
            {showStatus && <StatusBadge status={task.status} />}
            {task.area && (
              <span dir="auto" title={`Area: ${task.area.slug}`}
                className="inline-flex items-center rounded-full border border-series2/40 px-2 py-0.5 text-[11px] text-series2">
                {task.area.name}
              </span>
            )}
            <KindBadge kind={task.kind} hideTask />
            <SideBadge side={task.side} />
            <PointsBadge points={task.points} />
            <PriorityBadge priority={task.priority} />
            {overdue && <OverdueBadge />}
            {task.created_kind === 'agent' && <ActorBadge kind="agent" agent={task.created_agent} />}
            {task.restricted && (
              <span className="inline-flex items-center rounded-full border border-critical/30 px-2 py-0.5 text-[11px] text-ink-secondary">
                Restricted
              </span>
            )}
            <DeployBadge state={task.deploy_state} hideNone />
            <BlockedBadge ids={task.blocked_by} />
            {task.children_total > 0 && (
              <CountChip title="Subtasks closed out of total" tone={task.children_open === 0 ? 'good' : 'muted'}>
                <SubtasksIcon className="h-3 w-3" />
                {task.children_total - task.children_open}/{task.children_total} subtasks
              </CountChip>
            )}
            {task.criteria_total > 0 && (
              <CountChip
                title="Acceptance criteria met (or dropped) out of total"
                tone={task.criteria_open === 0 ? 'good' : 'muted'}
              >
                <CheckIcon className="h-3 w-3" />
                {met}/{task.criteria_total}
              </CountChip>
            )}
            {task.parts_total > 0 && (
              <CountChip
                title="Parts someone has taken, out of all parts. Open the task to take one."
                tone={task.parts_taken >= task.parts_total ? 'good' : 'muted'}
              >
                <PartIcon className="h-3 w-3" />
                parts {task.parts_taken ?? 0}/{task.parts_total} taken
              </CountChip>
            )}
            {task.open_questions > 0 && (
              <CountChip tone="warning">
                <QuestionIcon className="h-3 w-3" />
                {task.open_questions} open question{task.open_questions === 1 ? '' : 's'}
              </CountChip>
            )}
          </div>

          {claimIsLive(task) && (
            <div className="mt-2 flex min-w-0">
              <ClaimBadge task={task} />
            </div>
          )}

          <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-hairline pt-2">
            <People task={task} user={user} />
            <span
              className={`tabular me-auto whitespace-nowrap text-[11px] ${overdue ? 'text-critical' : 'text-ink-muted'}`}
            >
              {task.due_date ? `Due ${formatDate(task.due_date)}` : 'No due date'}
            </span>
            {take}
            {actions}
          </div>
        </>
      )}
    </article>
  )
}
