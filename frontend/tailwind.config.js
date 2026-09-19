/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  // Tokens resolve to CSS custom properties declared in index.css, so light and
  // dark values live in one place and SVG chart marks can reference the same
  // variables directly.
  theme: {
    extend: {
      colors: {
        surface: 'var(--surface-1)',
        'surface-raised': 'var(--surface-2)',
        page: 'var(--page)',
        ink: 'var(--text-primary)',
        'ink-secondary': 'var(--text-secondary)',
        'ink-muted': 'var(--text-muted)',
        hairline: 'var(--border)',
        grid: 'var(--grid)',
        baseline: 'var(--baseline)',
        series1: 'var(--series-1)',
        series2: 'var(--series-2)',
        series3: 'var(--series-3)',
        good: 'var(--status-good)',
        warning: 'var(--status-warning)',
        serious: 'var(--status-serious)',
        critical: 'var(--status-critical)',
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
