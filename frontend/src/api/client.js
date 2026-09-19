// Thin fetch wrapper. The dev server proxies /auth, /tasks and /kpi to the
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

async function request(path, { method = 'GET', body, params } = {}) {
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
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (response.status === 204) return null

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

export const api = {
  login: (email, password) => request('/auth/login', { method: 'POST', body: { email, password } }),
  me: () => request('/auth/me'),
  programmers: () => request('/auth/users', { params: { role: 'programmer' } }),

  tasks: () => request('/tasks'),
  task: (id) => request(`/tasks/${id}`),
  createTask: (payload) => request('/tasks', { method: 'POST', body: payload }),
  changeStatus: (id, status, comment) =>
    request(`/tasks/${id}/status`, { method: 'PATCH', body: { status, comment } }),
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

  teamKpi: (range) => request('/kpi/team', { params: range }),
  myKpi: (range) => request('/kpi/me', { params: range }),
  programmerKpi: (id, range) => request(`/kpi/programmer/${id}`, { params: range }),
}
