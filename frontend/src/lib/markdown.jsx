// A small Markdown renderer that builds React elements and never touches
// innerHTML, so raw HTML in a document shows as text. Covers what specs and
// plans use: headings, paragraphs, lists (nested, task lists), block quotes,
// fenced and indented code, tables, rules, emphasis, inline code and links.
//
// Safety rules:
// - No HTML passes through. `<b>` stays the four characters `<b>`.
// - Links open in a new tab with rel="noopener noreferrer", and only for
//   https, http and mailto. Anything else (javascript:, data:, relative)
//   renders as plain text.
// - Images never load. `![alt](url)` becomes a link labelled "Image: alt", so a
//   document cannot ping a remote server when someone opens it.
// - Every block gets dir="auto", so Arabic and English paragraphs each read
//   in their own direction. Code stays left to right.

import { Fragment } from 'react'

const MAX_DEPTH = 12

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/
const HEADING_RE = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/
const HR_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const QUOTE_RE = /^ {0,3}> ?/
const ITEM_RE = /^( *)([-*+]|\d{1,9}[.)])(\s+|$)(.*)$/
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const INDENTED_CODE_RE = /^( {4}|\t)/

function indentOf(line) {
  const match = /^ */.exec(line.replace(/\t/g, '    '))
  return match[0].length
}

function isBlank(line) {
  return line.trim() === ''
}

function isTableStart(lines, i) {
  return lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes('-')
}

/** Does `line` start a block that ends a paragraph? */
function startsBlock(lines, i) {
  const line = lines[i]
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    QUOTE_RE.test(line) ||
    ITEM_RE.test(line) ||
    isTableStart(lines, i)
  )
}

function splitRow(line) {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1)
  const cells = []
  let current = ''
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\\' && text[i + 1] === '|') {
      current += '|'
      i += 1
    } else if (text[i] === '|') {
      cells.push(current.trim())
      current = ''
    } else {
      current += text[i]
    }
  }
  cells.push(current.trim())
  return cells
}

/** Lines to a list of block objects. */
function parseBlocks(lines, depth = 0) {
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    if (isBlank(line)) {
      i += 1
      continue
    }

    const fence = FENCE_RE.exec(line)
    if (fence) {
      const marker = fence[1]
      const body = []
      i += 1
      while (i < lines.length) {
        const close = lines[i].trim()
        if (close.startsWith(marker[0].repeat(marker.length)) && /^(`+|~+)$/.test(close)) {
          i += 1
          break
        }
        body.push(lines[i])
        i += 1
      }
      blocks.push({ type: 'code', lang: fence[2] || '', text: body.join('\n') })
      continue
    }

    const heading = HEADING_RE.exec(line)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] ?? '' })
      i += 1
      continue
    }

    if (HR_RE.test(line)) {
      blocks.push({ type: 'hr' })
      i += 1
      continue
    }

    if (QUOTE_RE.test(line)) {
      const inner = []
      while (i < lines.length && !isBlank(lines[i])) {
        if (QUOTE_RE.test(lines[i])) inner.push(lines[i].replace(QUOTE_RE, ''))
        else if (!startsBlock(lines, i)) inner.push(lines[i])
        else break
        i += 1
      }
      blocks.push({
        type: 'quote',
        children: depth < MAX_DEPTH ? parseBlocks(inner, depth + 1) : [{ type: 'paragraph', text: inner.join('\n') }],
      })
      continue
    }

    const item = ITEM_RE.exec(line)
    if (item) {
      const baseIndent = item[1].length
      const ordered = /\d/.test(item[2])
      const start = ordered ? parseInt(item[2], 10) : null
      const items = []
      let loose = false
      while (i < lines.length) {
        const match = ITEM_RE.exec(lines[i])
        if (!match || match[1].length !== baseIndent || /\d/.test(match[2]) !== ordered) break
        const contentIndent = baseIndent + match[2].length + Math.max(1, Math.min(match[3].length, 4))
        const body = [match[4]]
        i += 1
        while (i < lines.length) {
          const next = lines[i]
          if (isBlank(next)) {
            // A blank line belongs to the item only when indented text follows.
            let j = i + 1
            while (j < lines.length && isBlank(lines[j])) j += 1
            if (j < lines.length && indentOf(lines[j]) >= contentIndent) {
              loose = true
              for (let k = i; k < j; k += 1) body.push('')
              i = j
              continue
            }
            break
          }
          const indent = indentOf(next)
          if (indent >= contentIndent || (indent > baseIndent && ITEM_RE.test(next))) {
            body.push(next.replace(/\t/g, '    ').slice(Math.min(indent, contentIndent)))
            i += 1
            continue
          }
          // Lazy continuation of the item's paragraph.
          if (indent > baseIndent || !startsBlock(lines, i)) {
            if (ITEM_RE.test(next)) break
            body.push(next.trim())
            i += 1
            continue
          }
          break
        }
        let checked = null
        const task = /^\[([ xX])\]\s+/.exec(body[0])
        if (task) {
          checked = task[1] !== ' '
          body[0] = body[0].slice(task[0].length)
        }
        items.push({
          checked,
          children: depth < MAX_DEPTH ? parseBlocks(body, depth + 1) : [{ type: 'paragraph', text: body.join('\n') }],
        })
        // Skip blank lines between items of the same list.
        let j = i
        while (j < lines.length && isBlank(lines[j])) j += 1
        if (j > i && j < lines.length) {
          const following = ITEM_RE.exec(lines[j])
          if (following && following[1].length === baseIndent && /\d/.test(following[2]) === ordered) {
            loose = true
            i = j
          }
        }
      }
      blocks.push({ type: 'list', ordered, start, items, loose })
      continue
    }

    if (isTableStart(lines, i)) {
      const header = splitRow(line)
      const align = splitRow(lines[i + 1]).map((cell) => {
        const left = cell.startsWith(':')
        const right = cell.endsWith(':')
        if (left && right) return 'center'
        if (right) return 'end'
        if (left) return 'start'
        return null
      })
      const rows = []
      i += 2
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) {
        rows.push(splitRow(lines[i]))
        i += 1
      }
      blocks.push({ type: 'table', header, align, rows })
      continue
    }

    if (INDENTED_CODE_RE.test(line)) {
      const body = []
      while (i < lines.length && (INDENTED_CODE_RE.test(lines[i]) || isBlank(lines[i]))) {
        body.push(lines[i].replace(/^( {4}|\t)/, ''))
        i += 1
      }
      while (body.length && isBlank(body[body.length - 1])) body.pop()
      blocks.push({ type: 'code', lang: '', text: body.join('\n') })
      continue
    }

    const para = [line]
    i += 1
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i)) {
      para.push(lines[i])
      i += 1
    }
    blocks.push({ type: 'paragraph', text: para.map((l) => l.replace(/^\s+/, '')).join('\n') })
  }
  return blocks
}

// --- inline ------------------------------------------------------------------

const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/

/** Links leave the app only for these schemes. */
export function safeLinkHref(raw) {
  const href = (raw || '').trim().replace(/^<|>$/g, '')
  try {
    const url = new URL(href)
    if (url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:') return url.href
  } catch {
    // Relative or broken: not a link.
  }
  return null
}

function ExternalLink({ href, children }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-series1 underline underline-offset-2 hover:opacity-80"
    >
      {children}
    </a>
  )
}

/** Index of the closing `marker` at or after `from`, not preceded by a backslash. */
function findClose(text, marker, from) {
  let at = text.indexOf(marker, from)
  while (at !== -1 && text[at - 1] === '\\') at = text.indexOf(marker, at + 1)
  return at
}

function isWordChar(ch) {
  return Boolean(ch) && /[\p{L}\p{N}]/u.test(ch)
}

/** Inline Markdown to React nodes. `noLinks` stops links inside link text. */
function parseInline(text, key = 'i', noLinks = false, depth = 0) {
  const out = []
  let buffer = ''
  let n = 0
  const flush = () => {
    if (buffer) out.push(buffer)
    buffer = ''
  }
  const push = (node) => {
    flush()
    out.push(<Fragment key={`${key}-${n++}`}>{node}</Fragment>)
  }
  const inner = (value, nested = noLinks) =>
    depth < MAX_DEPTH ? parseInline(value, `${key}-${n}`, nested, depth + 1) : value

  let i = 0
  while (i < text.length) {
    const ch = text[i]
    const rest = text.slice(i)

    if (ch === '\\' && text[i + 1] === '\n') {
      push(<br />)
      i += 2
      continue
    }
    if (ch === '\\' && PUNCTUATION.test(text[i + 1] || '')) {
      buffer += text[i + 1]
      i += 2
      continue
    }
    if (ch === ' ' && /^ {2,}\n/.test(rest)) {
      push(<br />)
      i += rest.indexOf('\n') + 1
      continue
    }

    if (ch === '`') {
      const run = /^`+/.exec(rest)[0]
      const close = text.indexOf(run, i + run.length)
      if (close !== -1) {
        const code = text.slice(i + run.length, close).replace(/\n/g, ' ')
        push(
          <code dir="ltr" className="rounded bg-surface-raised px-1 py-0.5 font-mono text-[0.85em]">
            {code.length > 2 && code.startsWith(' ') && code.endsWith(' ') ? code.slice(1, -1) : code}
          </code>,
        )
        i = close + run.length
        continue
      }
      buffer += run
      i += run.length
      continue
    }

    if (ch === '!' && text[i + 1] === '[') {
      const image = /^!\[([^\]]*)\]\(\s*([^)\s]*)(?:\s+"[^"]*")?\s*\)/.exec(rest)
      if (image) {
        const href = safeLinkHref(image[2])
        const label = `Image: ${image[1] || image[2] || 'untitled'}`
        push(href && !noLinks ? <ExternalLink href={href}>{label}</ExternalLink> : <span className="text-ink-muted">[{label}]</span>)
        i += image[0].length
        continue
      }
    }

    if (ch === '[' && !noLinks) {
      const link = /^\[((?:[^[\]\\]|\\.|\[[^\]]*\])*)\]\(\s*([^)\s]*)(?:\s+"[^"]*")?\s*\)/.exec(rest)
      if (link) {
        const href = safeLinkHref(link[2])
        const label = inner(link[1], true)
        push(href ? <ExternalLink href={href}>{label}</ExternalLink> : <span>{label}</span>)
        i += link[0].length
        continue
      }
    }

    if (ch === '<' && !noLinks) {
      const auto = /^<((?:https?:\/\/|mailto:)[^>\s]+)>/.exec(rest)
      if (auto) {
        const href = safeLinkHref(auto[1])
        push(href ? <ExternalLink href={href}>{auto[1]}</ExternalLink> : auto[1])
        i += auto[0].length
        continue
      }
    }

    if ((ch === 'h' || ch === 'H') && !noLinks && !isWordChar(text[i - 1])) {
      const bare = /^https?:\/\/[^\s<>]*[^\s<>.,:;"')\]!?*_~]/i.exec(rest)
      if (bare) {
        const href = safeLinkHref(bare[0])
        if (href) {
          push(<ExternalLink href={href}>{bare[0]}</ExternalLink>)
          i += bare[0].length
          continue
        }
      }
    }

    if ((ch === '*' || ch === '_' || ch === '~') && text[i + 1] === ch) {
      const marker = ch + ch
      const intraword = ch === '_' && isWordChar(text[i - 1])
      const close = findClose(text, marker, i + 2)
      if (!intraword && close > i + 2 && text[i + 2] !== ' ') {
        const body = inner(text.slice(i + 2, close))
        push(ch === '~' ? <del>{body}</del> : <strong className="font-semibold">{body}</strong>)
        i = close + 2
        continue
      }
    }

    if (ch === '*' || ch === '_') {
      const intraword = ch === '_' && isWordChar(text[i - 1])
      let close = findClose(text, ch, i + 1)
      while (close !== -1 && text[close + 1] === ch) close = findClose(text, ch, close + 2)
      if (
        !intraword &&
        close > i + 1 &&
        text[i + 1] !== ' ' &&
        text[close - 1] !== ' ' &&
        !(ch === '_' && isWordChar(text[close + 1]))
      ) {
        push(<em>{inner(text.slice(i + 1, close))}</em>)
        i = close + 1
        continue
      }
    }

    buffer += ch
    i += 1
  }
  flush()
  return out
}

// --- render ------------------------------------------------------------------

const HEADING_CLASSES = {
  1: 'text-xl font-semibold',
  2: 'text-lg font-semibold',
  3: 'text-base font-semibold',
  4: 'text-sm font-semibold',
  5: 'text-sm font-semibold text-ink-secondary',
  6: 'text-xs font-semibold uppercase tracking-wide text-ink-secondary',
}

const ALIGN_CLASSES = { start: 'text-start', center: 'text-center', end: 'text-end' }

function renderBlocks(blocks, key, tight = false) {
  return blocks.map((block, index) => {
    const k = `${key}-${index}`
    switch (block.type) {
      case 'heading': {
        const Tag = `h${block.level}`
        return (
          <Tag key={k} dir="auto" className={`${HEADING_CLASSES[block.level]} mt-4 first:mt-0`}>
            {parseInline(block.text, k)}
          </Tag>
        )
      }
      case 'paragraph':
        return tight ? (
          <span key={k} dir="auto" className="block">
            {parseInline(block.text, k)}
          </span>
        ) : (
          <p key={k} dir="auto" className="mt-3 leading-relaxed first:mt-0">
            {parseInline(block.text, k)}
          </p>
        )
      case 'code':
        return (
          <pre
            key={k}
            dir="ltr"
            className="mt-3 overflow-x-auto rounded-lg border border-hairline bg-surface-raised p-3 font-mono text-xs leading-relaxed first:mt-0"
          >
            <code>{block.text}</code>
          </pre>
        )
      case 'hr':
        return <hr key={k} className="my-4 border-hairline" />
      case 'quote':
        return (
          <blockquote
            key={k}
            dir="auto"
            className="mt-3 border-s-2 border-hairline ps-3 text-ink-secondary first:mt-0"
          >
            {renderBlocks(block.children, k)}
          </blockquote>
        )
      case 'list': {
        const Tag = block.ordered ? 'ol' : 'ul'
        return (
          <Tag
            key={k}
            start={block.ordered && block.start !== 1 ? block.start : undefined}
            className={`mt-3 space-y-1 ps-6 first:mt-0 ${block.ordered ? 'list-decimal' : 'list-disc'}`}
          >
            {block.items.map((item, itemIndex) => (
              <li
                key={`${k}-${itemIndex}`}
                dir="auto"
                className={item.checked !== null ? 'list-none' : ''}
              >
                {item.checked !== null && (
                  <input
                    type="checkbox"
                    checked={item.checked}
                    readOnly
                    disabled
                    aria-label={item.checked ? 'Done' : 'Not done'}
                    className="me-2 -ms-5 align-middle"
                  />
                )}
                {renderBlocks(item.children, `${k}-${itemIndex}`, !block.loose)}
              </li>
            ))}
          </Tag>
        )
      }
      case 'table':
        return (
          <div key={k} className="mt-3 overflow-x-auto first:mt-0">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  {block.header.map((cell, c) => (
                    <th
                      key={c}
                      dir="auto"
                      className={`border border-hairline bg-surface-raised px-2.5 py-1.5 font-semibold ${ALIGN_CLASSES[block.align[c]] ?? 'text-start'}`}
                    >
                      {parseInline(cell, `${k}-h${c}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, r) => (
                  <tr key={r}>
                    {block.header.map((_, c) => (
                      <td
                        key={c}
                        dir="auto"
                        className={`border border-hairline px-2.5 py-1.5 align-top ${ALIGN_CLASSES[block.align[c]] ?? 'text-start'}`}
                      >
                        {parseInline(row[c] ?? '', `${k}-${r}-${c}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      default:
        return null
    }
  })
}

/** Rendered Markdown. The container reads in the direction of its text. */
export default function Markdown({ source, className = '' }) {
  const lines = (source || '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = parseBlocks(lines)
  if (blocks.length === 0) {
    return <p className="text-sm text-ink-muted">This document is empty.</p>
  }
  return (
    <div dir="auto" className={`break-words text-sm ${className}`}>
      {renderBlocks(blocks, 'md')}
    </div>
  )
}
