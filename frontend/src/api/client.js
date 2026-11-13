// Thin fetch wrapper. The dev server proxies /auth, /tasks, /users, /kpi and /library to the
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
  constructor(message, status) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

function readDetail(body, fallback) {
  const detail = body?.detail
  if (typeof detail === 'string') return detail
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

async function request(path, { method = 'GET', body, params, form, as = 'json' } = {}) {
  const url = new URL(`${BASE_URL}${path}`, window.location.origin)
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, value)
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
    throw new ApiError(
      readDetail(payload, `Request failed (${response.status})`),
      response.status,
    )
  }
  return payload
}

/** True when the server refused a write because the task changed meanwhile. */
export function isVersionConflict(err) {
  return err instanceof ApiError && err.status === 409 && /changed since you read it/i.test(err.message)
}

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

  // filters: { mine, ready, side, tag, q, status_filter, include_closed, created_kind, created_by }
  tasks: (filters) => request('/tasks', { params: filters }),
  inbox: () => request('/tasks/inbox'),
  task: (id) => request(`/tasks/${id}`),
  createTask: (payload) => request('/tasks', { method: 'POST', body: payload }),
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

  // People. Leads and admins list; only admins change anything.
  adminUsers: () => request('/users'),
  createUser: (payload) => request('/users', { method: 'POST', body: payload }),
  updateUser: (id, payload) => request(`/users/${id}`, { method: 'PATCH', body: payload }),
  resetPassword: (id, password) =>
    request(`/users/${id}/password`, { method: 'POST', body: { password } }),
  botTokens: (id) => request(`/users/${id}/tokens`),
  issueBotToken: (id, payload) => request(`/users/${id}/tokens`, { method: 'POST', body: payload }),

  teamKpi: (range) => request('/kpi/team', { params: range }),
  myKpi: (range) => request('/kpi/me', { params: range }),
  programmerKpi: (id, range) => request(`/kpi/programmer/${id}`, { params: range }),
}
