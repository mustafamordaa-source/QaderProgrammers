import { api } from '../../api/client'

// GET /tasks/templates changes only with a deploy, so one fetch per page load
// is enough. A failed fetch is forgotten, so the next modal tries again.
let pending = null

export function loadTemplates() {
  if (!pending) {
    pending = api.templates().catch((err) => {
      pending = null
      throw err
    })
  }
  return pending
}
