export type IconName =
  | 'add' | 'folder' | 'more' | 'move' | 'close' | 'split-right' | 'split-down'
  | 'refresh' | 'reload' | 'snowflake' | 'play' | 'save' | 'load' | 'sessions'
  | 'memory' | 'help' | 'preserve' | 'up' | 'down' | 'maximize' | 'restore'

export function Icon({ name, size = 16 }: { name: IconName; size?: number }): JSX.Element {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
    className: 'ui-icon',
  }

  switch (name) {
    case 'add': return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>
    case 'folder': return <svg {...common}><path d="M3.5 7.5h6l2-2h9v13h-17z" /></svg>
    case 'more': return <svg {...common}><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></svg>
    case 'move': return <svg {...common}><path d="M12 3v18M3 12h18M12 3l-3 3m3-3 3 3M12 21l-3-3m3 3 3-3M3 12l3-3m-3 3 3 3M21 12l-3-3m3 3-3 3" /></svg>
    case 'close': return <svg {...common}><path d="M6 6l12 12M18 6 6 18" /></svg>
    case 'split-right': return <svg {...common}><rect x="3.5" y="4" width="17" height="16" rx="2" /><path d="M13 4v16M16.5 12h2.5m-1.25-1.25L19 12l-1.25 1.25" /></svg>
    case 'split-down': return <svg {...common}><rect x="4" y="3.5" width="16" height="17" rx="2" /><path d="M4 13h16M12 16.5V19m-1.25-1.25L12 19l1.25-1.25" /></svg>
    case 'refresh': return <svg {...common}><path d="M19 7v5h-5M5 17v-5h5" /><path d="M7.1 7.1A7 7 0 0 1 19 12M5 12a7 7 0 0 0 11.9 4.9" /></svg>
    case 'reload': return <svg {...common}><path d="M4 11a8 8 0 1 1 2.3 6M4 11V5m0 6h6" /><path d="M10 16h4" /></svg>
    case 'snowflake': return <svg {...common}><path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9M9.5 4.5 12 7l2.5-2.5M9.5 19.5 12 17l2.5 2.5" /></svg>
    case 'play': return <svg {...common}><path d="m8 5 11 7-11 7z" /></svg>
    case 'save': return <svg {...common}><path d="M5 3.5h12l2 2V20.5H5zM8 3.5v6h8v-6M8 20.5v-7h8v7" /></svg>
    case 'load': return <svg {...common}><path d="M4 8.5h6l2-2h8v12H4zM12 10v6m-2.5-2.5L12 16l2.5-2.5" /></svg>
    case 'sessions': return <svg {...common}><rect x="4" y="4" width="16" height="12" rx="2" /><path d="m7 8 2 2-2 2M11 12h4M8 20h8" /></svg>
    case 'memory': return <svg {...common}><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2.5v3M15 2.5v3M9 18.5v3M15 18.5v3M2.5 9h3M2.5 15h3M18.5 9h3M18.5 15h3M10 10h4v4h-4z" /></svg>
    case 'help': return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M9.8 9a2.3 2.3 0 1 1 3.1 2.2c-.9.4-.9 1.1-.9 1.8M12 17h.01" /></svg>
    case 'preserve': return <svg {...common}><path d="M12 3 5 6v5c0 4.6 2.8 8 7 10 4.2-2 7-5.4 7-10V6z" /><path d="m9 12 2 2 4-4" /></svg>
    case 'up': return <svg {...common}><path d="m6 14 6-6 6 6" /></svg>
    case 'down': return <svg {...common}><path d="m6 10 6 6 6-6" /></svg>
    case 'maximize': return <svg {...common}><path d="M8 4H4v4M16 4h4v4M4 16v4h4M20 16v4h-4" /></svg>
    case 'restore': return <svg {...common}><path d="M9 5H5v4M15 5h4v4M5 15v4h4M19 15v4h-4" /><path d="M9 9h6v6H9z" /></svg>
  }
}
