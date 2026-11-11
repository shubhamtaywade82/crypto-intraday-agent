'use client'

// Live agent activity feed — every scan, LLM verdict, risk rejection and fill.

import { useEffect, useRef } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { LogEntry } from '@/lib/engine-types'

const LEVEL_STYLE: Record<LogEntry['level'], { dot: string; text: string; tag: string }> = {
  info: { dot: 'bg-sky-400', text: 'text-zinc-300', tag: 'text-zinc-500' },
  trade: { dot: 'bg-emerald-400', text: 'text-emerald-300', tag: 'text-emerald-500/70' },
  warn: { dot: 'bg-amber-400', text: 'text-amber-200', tag: 'text-amber-500/70' },
  error: { dot: 'bg-red-400', text: 'text-red-300', tag: 'text-red-500/70' },
  llm: { dot: 'bg-fuchsia-400', text: 'text-fuchsia-200', tag: 'text-fuchsia-500/70' },
}

const time = (ts: number) => new Date(ts).toLocaleTimeString('en-GB', { hour12: false })

interface Props {
  logs: LogEntry[]
}

export function AgentFeed({ logs }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [logs.length])

  return (
    <ScrollArea className="h-[430px] rounded-md border border-zinc-800 bg-zinc-950/60">
      <div className="p-3 space-y-1.5 font-mono text-[11px] leading-relaxed" role="log" aria-live="polite">
        {logs.length === 0 && <p className="text-zinc-600 text-center py-8">waiting for agent activity…</p>}
        {logs.map((l, i) => {
          const st = LEVEL_STYLE[l.level] ?? LEVEL_STYLE.info
          return (
            <div key={`${l.ts}-${i}`} className="flex items-start gap-2">
              <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${st.dot}`} aria-hidden />
              <span className="shrink-0 text-zinc-600">{time(l.ts)}</span>
              <span className={`shrink-0 font-semibold ${st.tag}`}>{l.tag}</span>
              <span className={`${st.text} break-words min-w-0`}>{l.msg}</span>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  )
}

export default AgentFeed
