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

export const SearchIcon = (props) => (
  <Icon {...props}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3 3" />
  </Icon>
)

export const CloseIcon = (props) => (
  <Icon {...props}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Icon>
)

/** One person: Mine, My work. */
export const PersonIcon = (props) => (
  <Icon {...props}>
    <circle cx="8" cy="5.5" r="2.5" />
    <path d="M3 13.5a5 5 0 0 1 10 0" />
  </Icon>
)

/** Two people: everyone on a task. */
export const PeopleIcon = (props) => (
  <Icon {...props}>
    <circle cx="6" cy="5.5" r="2.25" />
    <path d="M1.75 13.5a4.25 4.25 0 0 1 8.5 0M10.5 3.4a2.25 2.25 0 0 1 0 4.2M12 9.6a4.25 4.25 0 0 1 2.25 3.9" />
  </Icon>
)

/** An open hand: free to take. */
export const HandIcon = (props) => (
  <Icon {...props}>
    <path d="M5 8.5V4a1 1 0 0 1 2 0v3.5M7 7V3a1 1 0 0 1 2 0v4M9 7V3.75a1 1 0 0 1 2 0V8.5M11 6.5a1 1 0 0 1 2 0V9a5 5 0 0 1-5 5h-.5a4 4 0 0 1-3.2-1.6L2.6 10a1 1 0 0 1 1.6-1.2L5 9.8" />
  </Icon>
)

/** A ring with a dot: status. */
export const StatusIcon = (props) => (
  <Icon {...props}>
    <circle cx="8" cy="8" r="5.5" />
    <circle cx="8" cy="8" r="1.75" fill="currentColor" stroke="none" />
  </Icon>
)

/** Three rising bars: priority. */
export const PriorityIcon = (props) => (
  <Icon {...props}>
    <path d="M3.5 13v-2.5M8 13V7.5M12.5 13V3" />
  </Icon>
)

/** A label tag: kind. */
export const KindIcon = (props) => (
  <Icon {...props}>
    <path d="M2.5 3.5v4l6 6 5-5-6-6h-4a1 1 0 0 0-1 1Z" />
    <circle cx="5.5" cy="5.5" r="0.75" fill="currentColor" stroke="none" />
  </Icon>
)

/** Stacked layers: side (frontend, backend, ...). */
export const SideIcon = (props) => (
  <Icon {...props}>
    <path d="m8 2.5 5.5 3L8 8.5l-5.5-3L8 2.5ZM2.5 8.5 8 11.5l5.5-3M2.5 11 8 14l5.5-3" />
  </Icon>
)

/** Four tiles: product area. */
export const AreaIcon = (props) => (
  <Icon {...props}>
    <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
    <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
    <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
    <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
  </Icon>
)

export const HashIcon = (props) => (
  <Icon {...props}>
    <path d="M6.5 2.5 5 13.5M11 2.5l-1.5 11M3 6h10.5M2.5 10H13" />
  </Icon>
)

/** A circle with an i: why something is locked. */
export const InfoIcon = (props) => (
  <Icon {...props}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 7.5V11M8 5v.01" />
  </Icon>
)

/** A puzzle-like split square: one part of a task. */
export const PartIcon = (props) => (
  <Icon {...props}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
    <path d="M8 2.5v11M2.5 8H8" />
  </Icon>
)

/** A graduation cap: who the task reaches (its audience). */
export const AudienceIcon = (props) => (
  <Icon {...props}>
    <path d="M1.5 6 8 3l6.5 3L8 9 1.5 6Z" />
    <path d="M4.5 7.6v2.9c0 .9 1.6 2 3.5 2s3.5-1.1 3.5-2V7.6M14.5 6v3.5" />
  </Icon>
)
