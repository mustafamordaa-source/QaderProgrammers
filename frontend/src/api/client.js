// Thin fetch wrapper. The dev server proxies /auth, /tasks, /users, /kpi, /library and
// /notifications to the
// backend, so a relative base URL works without CORS in development; set
// VITE_API_URL to point a production build at a different origin.
const BASE_URL = import.meta.env.VITE_API_URL ?? ''

const TOKEN_KEY = 'taskflow.token'

export function getToken() {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

export class ApiError extends Error {
  constructor(message, status, detail = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    // The raw `detail` when the server sent an object (for example the similar
    // tasks behind a duplicate refusal, or area suggestions).
    this.detail = detail
  }
}

// Words for an error the server sent without a `detail`, so nobody sees a bare code.
function statusText(status) {
  if (status === 400 || status === 422) return 'The server could not accept that request. Check the fields and try again.'
  if (status === 401) return 'Your session ended. Sign in again.'
  if (status === 403) return 'You do not have access to do that.'
  if (status === 404) return 'That item does not exist, or you cannot see it.'
  if (status === 409) return 'That clashes with the task’s current state. Reload and try again.'
  if (status === 429) return 'Too many requests. Wait a moment and try again.'
  if (status >= 500) return 'The server had a problem. Try again in a minute.'
  return `Request failed (${status})`
}

function readDetail(body, fallback) {
  const detail = body?.detail
  if (typeof detail === 'string') return detail
  if (detail && typeof detail === 'object' && !Array.isArray(detail) && detail.message) return detail.message
  // FastAPI validation errors arrive as a list of {loc, msg} objects.
  if (Array.isArray(detail) && detail.length > 0) {
    return detail
      .map((item) => {
        const field = Array.isArray(item.loc) ? item.loc[item.loc.length - 1] : null
        return field ? `${field}: ${item.msg}` : item.msg
      })
      .join('; ')
  }
  return fallback
}

// Lists are read a page at a time; the API's default page size.
export const PAGE_SIZE = 20

function headerNumber(response, name, fallback) {
  const value = Number(response.headers.get(name))
  return Number.isFinite(value) && response.headers.get(name) !== null ? value : fallback
}

// `as: 'page'` answers { items, total, page, pageSize, totalPages, points }: the
// rows plus the totals the API sends in its X-Total-* headers.
async function request(path, { method = 'GET', body, params, form, as = 'json' } = {}) {
  const url = new URL(`${BASE_URL}${path}`, window.location.origin)
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      const text = Array.isArray(value) ? value.join(',') : value
      if (text !== undefined && text !== null && text !== '') {
        url.searchParams.set(key, text)
      }
    }
  }

  const token = getToken()
  const response = await fetch(url, {
    method,
    headers: {
      // FormData sets its own multipart boundary; never set it by hand.
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: form ?? (body ? JSON.stringify(body) : undefined),
  })

  if (response.status === 204) return null

  // Plain-text and binary answers (diffs, downloads). Errors still come as JSON.
  if (response.ok && as === 'text') return response.text()
  if (response.ok && as === 'blob') return response.blob()

  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    const detail = payload?.detail
    throw new ApiError(
      readDetail(payload, statusText(response.status)),
      response.status,
      detail && typeof detail === 'object' && !Array.isArray(detail) ? detail : null,
    )
  }
  if (as === 'page') {
    const items = Array.isArray(payload) ? payload : []
    return {
      items,
      total: headerNumber(response, 'X-Total-Count', items.length),
      page: headerNumber(response, 'X-Page', 1),
      pageSize: headerNumber(response, 'X-Page-Size', PAGE_SIZE),
      totalPages: headerNumber(response, 'X-Total-Pages', 1),
      points: headerNumber(response, 'X-Total-Points', null),
    }
  }
  return payload
}

function page(path, params, pageNumber = 1, pageSize = PAGE_SIZE) {
  return request(path, { params: { ...params, page: pageNumber, page_size: pageSize }, as: 'page' })
}

/** True when the server refused a write because the task changed meanwhile. */
export function isVersionConflict(err) {
  return err instanceof ApiError && err.status === 409 && /changed since you read it/i.test(err.message)
}

const NOTIFICATION_EXPAND = 'task,thread'

export const api = {
  login: (email, password) => request('/auth/login', { method: 'POST', body: { email, password } }),
  me: () => request('/auth/me'),
  // Active people who can be assigned work. `side` narrows to one "works on".
  programmers: (side) => request('/auth/users', { params: { role: 'member', side } }),
  // Every active person, for question addressees and name lookups.
  directory: () => request('/auth/users'),

  // Personal API tokens for agents.
  scopes: () => request('/auth/scopes'),
  tokens: () => request('/auth/tokens'),
  createToken: (payload) => request('/auth/tokens', { method: 'POST', body: payload }),
  revokeToken: (id) => request(`/auth/tokens/${id}`, { method: 'DELETE' }),

  // filters: { mine, ready, side, tag, q, status_filter, include_closed, created_kind, created_by,
  //            kind, parent_id, pool, my_sides, limit,
  //            priority ('urgent,high'), kinds ('bug,feature'), subtasks ('all' | 'top' | 'only'),
  //            claimable (true: only rows the caller can claim now), lane ('planned' | 'backlog') }
  // ready=true lists what the caller can claim now: To do (lane planned) and Backlog.
  // Lists take arrays too; they go out comma-joined.
  tasks: (filters) => request('/tasks', { params: filters }),
  // One page of the same list. Extra filters: statuses ('blocked,needs_confirm'),
  // sort ('updated'), awaiting_decision (+ to: 'leads').
  tasksPage: (filters, pageNumber, pageSize) => page('/tasks', filters, pageNumber, pageSize),
  // Counts for the filter menus, for the same filters as the list (no paging):
  // { total, status, priority, kind, side, area, lane: {planned, backlog}, claimable, subtasks }.
  // Also `audience` ({students: n, ..., none: n}).
  facets: (filters) => request('/tasks/facets', { params: filters }),
  inbox: () => request('/tasks/inbox'),
  task: (id) => request(`/tasks/${id}`),
  // Skeleton, required headings and starter criteria per task kind.
  templates: () => request('/tasks/templates'),
  // The answer has `duplicate_of_existing: true` when a fingerprint matched an open task,
  // and `similar` / `suggested_areas` / `area_auto` from the duplicate check. A 409 whose
  // err.detail.similar is set means "looks like a duplicate": resend with duplicate_reason.
  createTask: (payload) => request('/tasks', { method: 'POST', body: payload }),
  // Tasks that look like this text, and the areas it fits. Writes nothing.
  similarTasks: (payload) => request('/tasks/similar', { method: 'POST', body: payload }),

  // Product areas: an open list; adding a name close to an existing one is refused
  // (409, err.detail.suggestions) unless confirm_new is true.
  areas: (q) => request('/areas', { params: { q } }),
  areasPage: (q, pageNumber, pageSize) => page('/areas', { q }, pageNumber, pageSize),
  createArea: (payload) => request('/areas', { method: 'POST', body: payload }),
  updateArea: (slug, payload) => request(`/areas/${encodeURIComponent(slug)}`, { method: 'PATCH', body: payload }),
  mergeArea: (slug, into) =>
    request(`/areas/${encodeURIComponent(slug)}/merge`, { method: 'POST', body: { into } }),
  addTaskLink: (id, kind, toTaskId) =>
    request(`/tasks/${id}/links`, { method: 'POST', body: { kind, to_task_id: toTaskId } }),
  removeTaskLink: (id, linkId) => request(`/tasks/${id}/links/${linkId}`, { method: 'DELETE' }),
  // One subtask per side. payload: { parts: [{side, title, assignee_id, points, criteria}],
  // order: [{before, after}] }. Returns the parent's detail.
  splitTask: (id, payload) => request(`/tasks/${id}/split`, { method: 'POST', body: payload }),
  updateTask: (id, payload) => request(`/tasks/${id}`, { method: 'PATCH', body: payload }),
  changeStatus: (id, { status, comment, expectedVersion }) =>
    request(`/tasks/${id}/status`, {
      method: 'PATCH',
      body: { status, comment: comment || null, expected_version: expectedVersion ?? null },
    }),
  assign: (id, assignee1, assignee2) =>
    request(`/tasks/${id}/assign`, {
      method: 'PATCH',
      body: { assignee_1_id: assignee1, assignee_2_id: assignee2 },
    }),
  reject: (id, toStatus, comment) =>
    request(`/tasks/${id}/reject`, {
      method: 'POST',
      body: { to_status: toStatus, comment },
    }),
  claim: (id, payload) => request(`/tasks/${id}/claim`, { method: 'POST', body: payload }),
  release: (id) => request(`/tasks/${id}/release`, { method: 'POST' }),
  setDeploy: (id, state, note) =>
    request(`/tasks/${id}/deploy`, { method: 'PATCH', body: { state, note: note || null } }),

  addComment: (id, payload) => request(`/tasks/${id}/comments`, { method: 'POST', body: payload }),
  resolveComment: (id, commentId) =>
    request(`/tasks/${id}/comments/${commentId}/resolve`, { method: 'POST' }),

  addCriterion: (id, text) => request(`/tasks/${id}/criteria`, { method: 'POST', body: { text } }),
  updateCriterion: (id, n, payload) =>
    request(`/tasks/${id}/criteria/${n}`, { method: 'PATCH', body: payload }),
  // Take one part: the server makes a subtask for criterion n and claims it for you.
  // Answers the new subtask (with `warnings`). payload: { agent?, ttl_hours? }.
  takePart: (id, n, payload = {}) =>
    request(`/tasks/${id}/criteria/${n}/take`, { method: 'POST', body: payload }),

  addGitLink: (id, payload) => request(`/tasks/${id}/git`, { method: 'POST', body: payload }),

  // Leads: accept or drop many proposals at once. Returns [{id, ok, status, error}].
  triage: (payload) => request('/tasks/triage', { method: 'POST', body: payload }),

  // Documents (versioned Markdown on a task).
  docs: (id) => request(`/tasks/${id}/docs`),
  doc: (id, slug, version) =>
    request(`/tasks/${id}/docs/${encodeURIComponent(slug)}`, { params: { version } }),
  createDoc: (id, payload) => request(`/tasks/${id}/docs`, { method: 'POST', body: payload }),
  saveDoc: (id, slug, payload) =>
    request(`/tasks/${id}/docs/${encodeURIComponent(slug)}`, { method: 'PUT', body: payload }),
  docHistory: (id, slug) => request(`/tasks/${id}/docs/${encodeURIComponent(slug)}/history`),
  docDiff: (id, slug, from, to) =>
    request(`/tasks/${id}/docs/${encodeURIComponent(slug)}/diff`, { params: { from, to }, as: 'text' }),
  restoreDoc: (id, slug, n) =>
    request(`/tasks/${id}/docs/${encodeURIComponent(slug)}/restore/${n}`, { method: 'POST' }),

  // Attachments. Downloads need the Authorization header, so they come back as
  // a Blob for an object URL instead of a plain link.
  uploadFile: (id, file, note) => {
    const form = new FormData()
    form.append('upload', file)
    if (note) form.append('note', note)
    return request(`/tasks/${id}/files`, { method: 'POST', form })
  },
  fileBlob: (id, fileId) => request(`/tasks/${id}/files/${fileId}`, { as: 'blob' }),
  removeFile: (id, fileId) => request(`/tasks/${id}/files/${fileId}`, { method: 'DELETE' }),

  // Context links: repo files and pages to read more.
  addContext: (id, payload) => request(`/tasks/${id}/context`, { method: 'POST', body: payload }),
  removeContext: (id, contextId) =>
    request(`/tasks/${id}/context/${contextId}`, { method: 'DELETE' }),

  // Everything written down: hub documents and linked repo files and pages.
  library: (filters) => request('/library', { params: filters }),
  libraryPage: (filters, pageNumber, pageSize) => page('/library', filters, pageNumber, pageSize),

  // People. Leads and admins list; only admins change anything.
  adminUsers: () => request('/users'),
  adminUsersPage: (q, pageNumber, pageSize) => page('/users', { q }, pageNumber, pageSize),
  createUser: (payload) => request('/users', { method: 'POST', body: payload }),
  updateUser: (id, payload) => request(`/users/${id}`, { method: 'PATCH', body: payload }),
  resetPassword: (id, password) =>
    request(`/users/${id}/password`, { method: 'POST', body: { password } }),
  botTokens: (id) => request(`/users/${id}/tokens`),
  issueBotToken: (id, payload) => request(`/users/${id}/tokens`, { method: 'POST', body: payload }),

  // Notifications. Preferences and the test email need a browser login.
  // Rows come with `task` (a snapshot) and `thread` (the comment and what it
  // replies to) so each one reads on its own.
  notifications: ({ unread, limit } = {}) =>
    request('/notifications', {
      params: { unread: unread ? 'true' : undefined, limit, expand: NOTIFICATION_EXPAND },
    }),
  notificationsPage: ({ unread } = {}, pageNumber, pageSize) =>
    page(
      '/notifications',
      { unread: unread ? 'true' : undefined, expand: NOTIFICATION_EXPAND },
      pageNumber,
      pageSize,
    ),
  notificationCount: () => request('/notifications/count'),
  markNotificationsRead: (ids) => request('/notifications/read', { method: 'POST', body: { ids } }),
  markAllNotificationsRead: () => request('/notifications/read', { method: 'POST', body: { all: true } }),
  notificationPreferences: () => request('/notifications/preferences'),
  updateNotificationPreferences: (payload) =>
    request('/notifications/preferences', { method: 'PATCH', body: payload }),
  sendTestEmail: () => request('/notifications/test', { method: 'POST' }),
  // Admins only.
  emailSenderStatus: () => request('/notifications/status'),

  teamKpi: (range) => request('/kpi/team', { params: range }),
  myKpi: (range) => request('/kpi/me', { params: range }),
  programmerKpi: (id, range) => request(`/kpi/programmer/${id}`, { params: range }),
}
