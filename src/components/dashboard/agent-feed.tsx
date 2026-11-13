'use client'

// Live autonomous agent telemetry: stream of market scan passes, Ollama LLM deliberations,
// risk gate rejections, and execution fills with category filters and pause control.

import { useEffect, useRef, useState } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Pause, Play } from 'lucide-react'
import type { LogEntry } from '@/lib/engine-types'

type FilterKey = 'all' | 'trade' | 'llm' | 'alerts'

const LEVEL_CONFIG: Record<LogEntry['level'], { dot: string; text: string; tag: string }> = {
  info: { dot: 'bg-sky-400', text: 'text-zinc-300', tag: 'border-sky-500/30 text-sky-400 bg-sky-500/10' },
  trade: { dot: 'bg-emerald-400', text: 'text-emerald-200 font-medium', tag: 'border-emerald-500/40 text-emerald-400 bg-emerald-500/10' },
  warn: { dot: 'bg-amber-400', text: 'text-amber-200', tag: 'border-amber-500/40 text-amber-400 bg-amber-500/10' },
  error: { dot: 'bg-rose-400', text: 'text-rose-200 font-medium', tag: 'border-rose-500/40 text-rose-400 bg-rose-500/10' },
  llm: { dot: 'bg-fuchsia-400', text: 'text-fuchsia-200', tag: 'border-fuchsia-500/40 text-fuchsia-400 bg-fuchsia-500/10' },
}

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false })
}

function matchesFilter(level: LogEntry['level'], filter: FilterKey): boolean {
  if (filter === 'all') return true
  if (filter === 'trade') return level === 'trade'
  if (filter === 'llm') return level === 'llm'
  return level === 'warn' || level === 'error'
}

function LogItem({ log }: { log: LogEntry }) {
  const conf = LEVEL_CONFIG[log.level] ?? LEVEL_CONFIG.info
  return (
    <div className="flex items-start gap-2 py-0.5 border-b border-zinc-900/60 font-mono text-[11px] leading-relaxed">
      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${conf.dot}`} aria-hidden />
      <span className="shrink-0 text-zinc-500 tabular-nums">{time(log.ts)}</span>
      <Badge variant="outline" className={`h-4 shrink-0 px-1 py-0 text-[9px] font-mono ${conf.tag}`}>
        {log.tag}
      </Badge>
      <span className={`min-w-0 break-words ${conf.text}`}>{log.msg}</span>
    </div>
  )
}

export function AgentFeed({ logs }: Props) {
  const [filter, setFilter] = useState<FilterKey>('all')
  const [autoScroll, setAutoScroll] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)

  const filteredLogs = logs.filter((l) => matchesFilter(l.level, filter))

  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [logs.length, autoScroll])

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-1 pb-1 border-b border-zinc-800/80">
        <div className="flex items-center gap-1">
          {(['all', 'trade', 'llm', 'alerts'] as FilterKey[]).map((key) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`rounded px-2 py-0.5 text-[10px] font-mono transition-colors uppercase ${
                filter === key ? 'bg-zinc-800 text-white font-semibold' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {key}
            </button>
          ))}
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setAutoScroll((prev) => !prev)}
          className="h-6 px-1.5 text-[10px] text-zinc-400 hover:text-zinc-200"
          title={autoScroll ? 'Pause autoscroll' : 'Resume autoscroll'}
        >
          {autoScroll ? <Pause className="h-3 w-3 mr-1" /> : <Play className="h-3 w-3 mr-1" />}
          {autoScroll ? 'Pause' : 'Live'}
        </Button>
      </div>

      <ScrollArea className="min-h-[360px] flex-1 rounded-md lg:min-h-0 border border-zinc-800/70 bg-zinc-950/60 p-2">
        <div role="log" aria-live="polite">
          {filteredLogs.length === 0 ? (
            <p className="py-12 text-center font-mono text-xs text-zinc-600">no telemetry events recorded</p>
          ) : (
            filteredLogs.map((l, i) => <LogItem key={`${l.ts}-${i}`} log={l} />)
          )}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>
    </div>
  )
}

interface Props {
  logs: LogEntry[]
}

export default AgentFeed
