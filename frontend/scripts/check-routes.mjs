/**
 * Fails if a client-side route shares a prefix with an API path proxied in dev.
 *
 * Vite matches proxy entries by prefix, so a client route named after an API
 * prefix is handed to the backend on any hard page load — a refresh, a pasted
 * link, a bookmark. Clicking through the app still works, which is exactly what
 * makes it easy to ship: `/kpi` and `/users` both collided this way and only
 * surfaced when a test loaded the URL directly instead of clicking a link.
 *
 * Run with: npm run check:routes
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function read(file) {
  return readFileSync(resolve(root, file), 'utf8')
}

const routes = [...read('src/App.jsx').matchAll(/path=["'](\/[^"'*]*)["']/g)]
  .map((match) => match[1])
  .filter((path) => path !== '/')

const proxies = [...read('vite.config.js').matchAll(/^\s*'(\/[^']+)':\s*'http/gm)].map(
  (match) => match[1],
)

if (routes.length === 0 || proxies.length === 0) {
  console.error(
    `check-routes: parsed ${routes.length} routes and ${proxies.length} proxy entries — ` +
      'one of the files no longer matches the expected shape, so this check is not ' +
      'actually verifying anything. Fix the parsing before trusting it.',
  )
  process.exit(2)
}

const collisions = []
for (const route of routes) {
  for (const prefix of proxies) {
    if (route === prefix || route.startsWith(`${prefix}/`)) {
      collisions.push({ route, prefix })
    }
  }
}

if (collisions.length > 0) {
  console.error('check-routes: client routes collide with proxied API prefixes:\n')
  for (const { route, prefix } of collisions) {
    console.error(
      `  ${route}  →  proxied to the API by '${prefix}'. A hard load of ${route} ` +
        'will return the API response instead of the app.',
    )
  }
  console.error('\nRename the client route, or narrow the proxy entry.')
  process.exit(1)
}

console.log(
  `check-routes: ok — ${routes.length} client routes (${routes.join(', ')}) ` +
    `clear of ${proxies.length} API prefixes (${proxies.join(', ')})`,
)
