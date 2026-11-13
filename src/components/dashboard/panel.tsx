import type { ReactNode } from 'react'

interface PanelProps {
  title: ReactNode
  icon?: ReactNode
  actions?: ReactNode
  footer?: ReactNode
  /** body scrolls itself; use for lists and tables */
  scroll?: boolean
  className?: string
  children: ReactNode
}

// Bordered workspace panel. On desktop it fills its grid cell and only the body
// scrolls, so the page itself never does. On mobile it sizes to its content.
export function Panel({ title, icon, actions, footer, scroll = true, className = '', children }: PanelProps) {
  return (
    <section className={`flex min-h-0 flex-col rounded-lg border border-zinc-800 bg-zinc-950/70 lg:h-full ${className}`}>
      <header className="flex min-h-10 shrink-0 items-center gap-2 border-b border-zinc-800/70 px-3 py-2">
        <h2 className="flex min-w-0 items-center gap-2 truncate text-sm font-medium text-zinc-200">
          {icon}
          <span className="truncate">{title}</span>
        </h2>
        {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      <div className={`min-h-0 flex-1 p-2 sm:p-3 ${scroll ? 'overflow-y-auto' : 'flex flex-col overflow-hidden'}`}>
        {children}
      </div>
      {footer && <footer className="shrink-0 border-t border-zinc-800/70 px-3 py-2">{footer}</footer>}
    </section>
  )
}

export default Panel
