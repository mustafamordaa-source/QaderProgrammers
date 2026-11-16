import { useMemo, useState } from 'react'
import { AreaIcon, ChevronDown, ChevronRight } from './BoardIcons'
import { MenuChip, Option, control } from './filterParts'

const byName = (a, b) => a.name.localeCompare(b.name)

/**
 * The flat area list as a tree: `roots` (top level, by name) and `kids` (slug ->
 * sub-areas, by name). An area whose parent is not in the list counts as top level.
 */
export function buildAreaTree(areas) {
  const bySlug = new Map(areas.map((area) => [area.slug, area]))
  const kids = new Map()
  const roots = []
  for (const area of areas) {
    if (area.parent && area.parent !== area.slug && bySlug.has(area.parent)) {
      if (!kids.has(area.parent)) kids.set(area.parent, [])
      kids.get(area.parent).push(area)
    } else {
      roots.push(area)
    }
  }
  roots.sort(byName)
  for (const list of kids.values()) list.sort(byName)
  return { bySlug, kids, roots }
}

/** Slugs from the top down to `slug`, itself included. */
function lineage(tree, slug) {
  const out = []
  const seen = new Set()
  let current = tree.bySlug.get(slug)
  while (current && !seen.has(current.slug)) {
    seen.add(current.slug)
    out.unshift(current.slug)
    current = current.parent ? tree.bySlug.get(current.parent) : null
  }
  return out
}

/** Names from the top down, e.g. ["Platform design", "Redesign: Exams engine"]. */
export function areaPath(tree, slug) {
  const area = tree.bySlug.get(slug)
  if (!area) return [slug]
  if (Array.isArray(area.path) && area.path.length) return area.path
  return lineage(tree, slug).map((s) => tree.bySlug.get(s)?.name ?? s)
}

/** Every area below `slug`, for a parent's count when facets have no area_tree. */
function subtreeSlugs(tree, slug, seen = new Set()) {
  if (seen.has(slug)) return []
  seen.add(slug)
  return [slug, ...(tree.kids.get(slug) ?? []).flatMap((child) => subtreeSlugs(tree, child.slug, seen))]
}

function makeCounter(tree, facets) {
  if (!facets) return () => undefined
  if (facets.area_tree) return (slug) => facets.area_tree[slug] ?? 0
  // Older hubs: add up the exact counts of the area and everything under it.
  const exact = facets.area ?? {}
  return (slug) => subtreeSlugs(tree, slug).reduce((sum, s) => sum + (exact[s] ?? 0), 0)
}

/**
 * The Area filter as a tree: top-level areas with their sub-areas indented under
 * a chevron. Picking a parent filters to its whole subtree (the API's `area=`
 * already includes sub-areas). Typing searches every level and shows the path.
 */
export default function AreaTreeMenu({ value, tree, onChange, facetParams }) {
  const [query, setQuery] = useState('')
  // Open the branch that holds the current pick, so it shows on opening.
  const [expanded, setExpanded] = useState(() => new Set(value ? lineage(tree, value).slice(0, -1) : []))
  const total = tree.bySlug.size
  const needle = query.trim().toLowerCase()
  const found = useMemo(
    () =>
      needle
        ? [...tree.bySlug.values()]
            .filter((a) => a.name.toLowerCase().includes(needle) || a.slug.includes(needle))
            .sort(byName)
        : null,
    [needle, tree],
  )
  const current = value ? tree.bySlug.get(value) : null

  const toggle = (slug) =>
    setExpanded((now) => {
      const next = new Set(now)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })

  return (
    <MenuChip
      icon={AreaIcon}
      label="Area"
      summary={value ? current?.name ?? value : null}
      active={Boolean(value)}
      facetParams={facetParams}
      omit={['area']}
      width="w-80"
    >
      {(facets, close) => {
        const countOf = makeCounter(tree, facets)
        const pick = (slug) => {
          onChange(slug)
          close()
        }

        const renderRow = (area, depth) => {
          const children = tree.kids.get(area.slug) ?? []
          const isOpen = expanded.has(area.slug)
          return (
            <li key={area.slug} role="none">
              <div className="flex items-center" style={{ paddingInlineStart: `${depth * 1.25}rem` }}>
                {children.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => toggle(area.slug)}
                    aria-expanded={isOpen}
                    aria-label={`${isOpen ? 'Hide' : 'Show'} the ${children.length} sub-areas of ${area.name}`}
                    className="grid h-7 w-6 shrink-0 place-items-center rounded text-ink-muted hover:bg-surface-raised hover:text-ink"
                  >
                    {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3 rtl:rotate-180" />}
                  </button>
                ) : (
                  <span aria-hidden="true" className="w-6 shrink-0" />
                )}
                <Option
                  checked={value === area.slug}
                  onClick={() => pick(area.slug)}
                  count={countOf(area.slug)}
                  className="flex-1"
                >
                  {area.name}
                </Option>
              </div>
              {isOpen && children.length > 0 && <ul role="none">{children.map((child) => renderRow(child, depth + 1))}</ul>}
            </li>
          )
        }

        return (
          <>
            {total > 8 && (
              <input
                type="search"
                aria-label="Find an area"
                placeholder="Find an area…"
                dir="auto"
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className={`${control} mb-1 w-full border-hairline`}
              />
            )}
            <div className="max-h-72 overflow-y-auto">
              <Option checked={!value} onClick={() => pick('')} count={facets?.total}>
                All areas
              </Option>
              {found ? (
                <ul role="none">
                  {found.map((area) => {
                    const path = areaPath(tree, area.slug)
                    return (
                      <li key={area.slug} role="none">
                        <Option checked={value === area.slug} onClick={() => pick(area.slug)} count={countOf(area.slug)}>
                          {area.name}
                          {path.length > 1 && (
                            <span className="block truncate text-[11px] font-normal text-ink-muted">
                              {path.slice(0, -1).join(' › ')}
                            </span>
                          )}
                        </Option>
                      </li>
                    )
                  })}
                  {found.length === 0 && <p className="px-2 py-1.5 text-xs text-ink-muted">No area matches.</p>}
                </ul>
              ) : (
                <ul role="none">{tree.roots.map((area) => renderRow(area, 0))}</ul>
              )}
            </div>
            {tree.kids.size > 0 && (
              <p className="border-t border-hairline px-2 pt-1.5 text-[11px] text-ink-muted">
                A parent area includes its sub-areas; its count adds them up.
              </p>
            )}
          </>
        )
      }}
    </MenuChip>
  )
}

