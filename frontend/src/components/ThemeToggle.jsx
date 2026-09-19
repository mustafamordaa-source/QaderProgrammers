import { useEffect, useState } from 'react'

const STORAGE_KEY = 'taskflow.theme'

/** Cycles light → dark → follow the OS. */
export default function ThemeToggle() {
  const [theme, setTheme] = useState(() => localStorage.getItem(STORAGE_KEY) ?? 'system')

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') {
      root.removeAttribute('data-theme')
      localStorage.removeItem(STORAGE_KEY)
    } else {
      root.setAttribute('data-theme', theme)
      localStorage.setItem(STORAGE_KEY, theme)
    }
  }, [theme])

  const next = { system: 'light', light: 'dark', dark: 'system' }[theme]
  const label = { system: 'Theme: system', light: 'Theme: light', dark: 'Theme: dark' }[theme]

  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      title={label}
      aria-label={label}
      className="rounded-lg border border-hairline px-2.5 py-1.5 text-xs text-ink-secondary transition hover:text-ink"
    >
      {{ system: 'Auto', light: 'Light', dark: 'Dark' }[theme]}
    </button>
  )
}
