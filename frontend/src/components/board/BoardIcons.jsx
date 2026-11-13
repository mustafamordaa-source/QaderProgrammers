// Small stroke icons for the board. Decorative: every use sits next to a text
// label, a title or an aria-label, so they stay aria-hidden.

function Icon({ children, className = 'h-3.5 w-3.5', strokeWidth = 1.75 }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      {children}
    </svg>
  )
}

export const ChevronLeft = (props) => (
  <Icon {...props}>
    <path d="M10 3.5 5.5 8l4.5 4.5" />
  </Icon>
)

export const ChevronRight = (props) => (
  <Icon {...props}>
    <path d="M6 3.5 10.5 8 6 12.5" />
  </Icon>
)

export const ChevronDown = (props) => (
  <Icon {...props}>
    <path d="M3.5 6 8 10.5 12.5 6" />
  </Icon>
)

/** Two arrows pointing in: collapse a column. */
export const CollapseIcon = (props) => (
  <Icon {...props}>
    <path d="M2.5 4.5 6 8l-3.5 3.5M13.5 4.5 10 8l3.5 3.5" />
  </Icon>
)

export const BlockedIcon = (props) => (
  <Icon {...props}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="m4.2 11.8 7.6-7.6" />
  </Icon>
)

export const SubtasksIcon = (props) => (
  <Icon {...props}>
    <path d="M4 2.5v8a1.5 1.5 0 0 0 1.5 1.5H12M4 6.5h8" />
  </Icon>
)

export const CheckIcon = (props) => (
  <Icon {...props}>
    <path d="m3 8.5 3 3 7-7" />
  </Icon>
)

export const QuestionIcon = (props) => (
  <Icon {...props}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M6.4 6.3a1.7 1.7 0 0 1 3.2.6c0 1.1-1.6 1.4-1.6 2.4M8 11.3v.01" />
  </Icon>
)

export const AgentIcon = (props) => (
  <Icon {...props}>
    <rect x="3" y="5" width="10" height="8" rx="2" />
    <path d="M8 2.5V5M6 9h.01M10 9h.01" />
  </Icon>
)

export const DeployIcon = (props) => (
  <Icon {...props}>
    <path d="M8 13.5V5M4.5 8.5 8 5l3.5 3.5M3 2.5h10" />
  </Icon>
)

export const ClockIcon = (props) => (
  <Icon {...props}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5v3l2 1.5" />
  </Icon>
)

export const OpenIcon = (props) => (
  <Icon {...props}>
    <path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />
  </Icon>
)

/** A flag: take a claim on a task. */
export const ClaimIcon = (props) => (
  <Icon {...props}>
    <path d="M4 13.5V2.5M4 3h7.5l-1.5 2.5L11.5 8H4" />
  </Icon>
)

export const LockIcon = (props) => (
  <Icon {...props}>
    <path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7M4 7h8v6H4z" />
  </Icon>
)
