import { useState } from 'react'
import { api } from '../../../api/client'
import { ActorBadge, CommentKindBadge, PlainText } from '../../Badges'
import {
  COMMENT_KIND_LABELS,
  COMPOSER_KINDS,
  HANDBACK_TEMPLATE,
  missingHandbackHeadings,
} from '../../../lib/constants'
import { formatDateTime } from '../../../lib/format'
import { linkButton, primaryButton, secondaryButton, smallInputClass } from './ui'
import MentionTextarea, { MentionHint } from './MentionTextarea'

const PARKABLE = ['backlog', 'to_do', 'in_progress', 'in_review']

function personLabel(person) {
  if (!person) return ''
  return person.handle ? `@${person.handle}` : person.name
}

function handbackProblem(kind, body) {
  if (kind !== 'handback') return null
  const missing = missingHandbackHeadings(body)
  return missing.length ? `Fill in: ${missing.join(', ')}` : null
}

/** Reply box under a top-level comment. Answers resolve the question. */
function ReplyForm({ ctx, parent, onDone }) {
  const { task, user, people, busy, run } = ctx
  const isOpenQuestion = parent.kind === 'question' && !parent.resolved_at
  const [kind, setKind] = useState(isOpenQuestion ? 'answer' : 'note')
  const [body, setBody] = useState('')

  async function submit(event) {
    event.preventDefault()
    const ok = await run(
      () => api.addComment(task.id, { kind, body: body.trim(), parent_id: parent.id }),
      { reloadAfter: true },
    )
    if (ok) onDone()
  }

  return (
    <form onSubmit={submit} className="mt-2 space-y-2">
      {parent.kind === 'question' && (
        <div className="flex gap-4 text-xs">
          {(isOpenQuestion ? ['answer', 'note'] : ['note']).map((value) => (
            <label key={value} className="inline-flex items-center gap-1.5">
              <input type="radio" name={`reply-kind-${parent.id}`} checked={kind === value} onChange={() => setKind(value)} />
              {value === 'answer' ? 'Answer (closes the question)' : 'Note'}
            </label>
          ))}
        </div>
      )}
      <MentionTextarea
        id={`reply-${parent.id}`}
        aria-label="Reply"
        rows={3}
        dir="auto"
        autoFocus
        required
        maxLength={20000}
        value={body}
        onChange={setBody}
        people={people}
        user={user}
        className={smallInputClass}
      />
      <MentionHint />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} className={secondaryButton}>Cancel</button>
        <button type="submit" disabled={busy || !body.trim()} className={primaryButton}>
          {kind === 'answer' ? 'Send answer' : 'Reply'}
        </button>
      </div>
    </form>
  )
}

function CommentView({ ctx, comment, replies = [], isReply = false }) {
  const { task, user, isLead, isReadOnly, busy, run } = ctx
  const [replying, setReplying] = useState(false)
  const openQuestion = comment.kind === 'question' && !comment.resolved_at
  const canResolve =
    openQuestion &&
    !isReadOnly &&
    (isLead || comment.author?.id === user.id || comment.to_user?.id === user.id)

  return (
    <li className={isReply ? 'border-s-2 border-hairline ps-3' : 'rounded-lg border border-hairline p-3'}>
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <span dir="auto" className="font-medium">{comment.author?.name ?? 'Someone'}</span>
        <ActorBadge kind={comment.actor_kind} agent={comment.agent_name} />
        <CommentKindBadge kind={comment.kind} />
        {comment.to_user && (
          <span dir="auto" className="text-xs text-ink-secondary">to {personLabel(comment.to_user)}</span>
        )}
        {comment.kind === 'question' && (
          <span className={`text-xs ${openQuestion ? 'font-medium text-warning' : 'text-ink-muted'}`}>
            {openQuestion ? 'Open' : 'Resolved'}
          </span>
        )}
        <time className="ms-auto text-xs text-ink-muted">{formatDateTime(comment.created_at)}</time>
      </div>
      <PlainText className="mt-1.5 text-sm leading-relaxed">{comment.body}</PlainText>

      {!isReadOnly && !isReply && (
        <div className="mt-2 flex flex-wrap gap-3">
          {!replying && (
            <button type="button" className={linkButton} onClick={() => setReplying(true)}>
              {openQuestion ? 'Answer' : 'Reply'}
            </button>
          )}
          {canResolve && (
            <button
              type="button"
              className={linkButton}
              disabled={busy}
              onClick={() => run(() => api.resolveComment(task.id, comment.id), { reloadAfter: true })}
            >
              Resolve without answer
            </button>
          )}
        </div>
      )}

      {replies.length > 0 && (
        <ul className="mt-3 space-y-3">
          {replies.map((reply) => (
            <CommentView key={reply.id} ctx={ctx} comment={reply} isReply />
          ))}
        </ul>
      )}

      {replying && <ReplyForm ctx={ctx} parent={comment} onDone={() => setReplying(false)} />}
    </li>
  )
}

function Composer({ ctx }) {
  const { task, user, people, busy, run } = ctx
  const [kind, setKind] = useState('note')
  const [body, setBody] = useState('')
  const [to, setTo] = useState('')
  const [wait, setWait] = useState(false)
  const [localError, setLocalError] = useState(null)

  function changeKind(next) {
    setKind(next)
    setLocalError(null)
    // Prefill the hand-back headings; leave anything the user already typed.
    if (next === 'handback' && !body.trim()) setBody(HANDBACK_TEMPLATE)
    if (next !== 'handback' && body === HANDBACK_TEMPLATE) setBody('')
  }

  async function submit(event) {
    event.preventDefault()
    const problem = handbackProblem(kind, body)
    if (problem) {
      setLocalError(problem)
      return
    }
    setLocalError(null)
    const payload = { kind, body: body.trim() }
    if (kind === 'question') {
      payload.to = to
      payload.wait = wait
    }
    const ok = await run(() => api.addComment(task.id, payload), { reloadAfter: true })
    if (ok) {
      setBody('')
      setKind('note')
      setTo('')
      setWait(false)
    }
  }

  const askable = people.filter((p) => p.id !== user.id)

  return (
    <form onSubmit={submit} className="space-y-2 rounded-lg border border-hairline p-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm font-medium" htmlFor="comment-kind">Post a</label>
        <select
          id="comment-kind"
          value={kind}
          onChange={(e) => changeKind(e.target.value)}
          className={`${smallInputClass} w-auto`}
        >
          {COMPOSER_KINDS.map((value) => (
            <option key={value} value={value}>{COMMENT_KIND_LABELS[value]}</option>
          ))}
        </select>
        {kind === 'question' && (
          <>
            <label className="text-sm" htmlFor="question-to">to</label>
            <select
              id="question-to"
              required
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className={`${smallInputClass} w-auto`}
            >
              <option value="">Choose a person</option>
              {askable.map((p) => (
                <option key={p.id} value={p.handle || String(p.id)}>
                  {p.name}{p.handle ? ` (@${p.handle})` : ''}
                </option>
              ))}
            </select>
          </>
        )}
      </div>

      {kind === 'question' && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={wait} onChange={(e) => setWait(e.target.checked)} />
          <span>
            Pause the task until this is answered
            <span className="block text-xs text-ink-muted">
              {PARKABLE.includes(task.status)
                ? 'The task moves to Needs confirmation and returns where it was once every open question is answered.'
                : 'Only tasks in Backlog, To do, In progress or In review can be paused.'}
            </span>
          </span>
        </label>
      )}

      <MentionTextarea
        id="comment-body"
        aria-label="Comment"
        rows={kind === 'handback' ? 8 : 3}
        dir="auto"
        required
        maxLength={20000}
        value={body}
        onChange={setBody}
        people={people}
        user={user}
        placeholder={kind === 'question' ? 'What do you need to know?' : 'Write a comment. Type @ to mention someone.'}
        className={`${smallInputClass} ${kind === 'handback' ? 'font-mono text-xs' : ''}`}
      />
      <MentionHint />
      {kind === 'handback' && (
        <p className="text-xs text-ink-muted">
          Summary, Checks run and Left need text. The Summary line replaces the task summary.
        </p>
      )}
      {localError && <p role="alert" className="text-sm text-critical">{localError}</p>}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={busy || !body.trim() || (kind === 'question' && !to)}
          className={primaryButton}
        >
          {kind === 'question' ? 'Ask' : `Post ${COMMENT_KIND_LABELS[kind].toLowerCase()}`}
        </button>
      </div>
    </form>
  )
}

export default function DiscussionTab({ ctx, comments }) {
  const top = comments.filter((c) => !c.parent_id)
  const replies = {}
  for (const c of comments) {
    if (c.parent_id) (replies[c.parent_id] ??= []).push(c)
  }

  return (
    <div className="space-y-4">
      {top.length === 0 ? (
        <p className="text-sm text-ink-muted">No comments yet.</p>
      ) : (
        <ul className="space-y-3">
          {top.map((comment) => (
            <CommentView key={comment.id} ctx={ctx} comment={comment} replies={replies[comment.id]} />
          ))}
        </ul>
      )}
      {!ctx.isReadOnly && <Composer ctx={ctx} />}
    </div>
  )
}
