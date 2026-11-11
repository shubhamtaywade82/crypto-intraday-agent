'use client'

// Telegram notifier settings panel.
// Configures @nemesis-oss/tg-format-driven notifications: entry, exit,
// risk halt, scan digest, agent start/stop, engine boot.
// The bot token is never sent back from the engine (only a masked preview);
// the input field is intentionally left uncontrolled so existing tokens
// stay hidden until the user pastes a new one.

import { useState } from 'react'
import { Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { toast } from '@/hooks/use-toast'
import { ENGINE_REST, type TelegramSafeConfig, type TelegramEvent } from '@/lib/engine-types'

const EVENT_LABELS: Array<{ key: TelegramEvent; label: string; hint: string }> = [
  { key: 'boot', label: 'Engine boot', hint: 'When the engine starts' },
  { key: 'agent', label: 'Agent start/stop', hint: 'Autonomous loop toggled' },
  { key: 'entry', label: 'Position opened', hint: 'New paper position filled' },
  { key: 'exit', label: 'Position closed', hint: 'TP / SL / EOD / manual / agent-exit' },
  { key: 'risk_halt', label: 'Risk halt', hint: 'Daily-loss cutoff triggered' },
  { key: 'scan_digest', label: 'Scan digest', hint: 'Each cycle that executes a trade (can be chatty)' },
]

export function TelegramPanel({ config }: { config: TelegramSafeConfig | undefined }) {
  const [enabled, setEnabled] = useState<boolean>(config?.enabled ?? false)
  const [chatId, setChatId] = useState<string>(config?.chatId ?? '')
  const [tokenInput, setTokenInput] = useState<string>('')
  const [events, setEvents] = useState<Record<TelegramEvent, boolean>>(() => ({
    boot: config?.events?.boot ?? true,
    agent: config?.events?.agent ?? true,
    entry: config?.events?.entry ?? true,
    exit: config?.events?.exit ?? true,
    risk_halt: config?.events?.risk_halt ?? true,
    scan_digest: config?.events?.scan_digest ?? false,
  }))
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  const hasToken = !!config?.hasToken
  const masked = config?.tokenMasked ?? ''

  async function save(patch: Partial<{ enabled: boolean; chatId: string; botToken: string; events: Record<TelegramEvent, boolean> }>) {
    setSaving(true)
    try {
      const r = await fetch(ENGINE_REST('/engine/telegram/config'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      }).then((x) => x.json())
      if (r.ok) {
        toast({ title: 'Telegram config saved', description: r.config?.enabled ? 'Notifications enabled' : 'Notifications disabled' })
      } else {
        toast({ title: 'Save failed', description: r.error || 'unknown', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Engine unreachable', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  async function testSend() {
    setTesting(true)
    try {
      const r = await fetch(ENGINE_REST('/engine/telegram/test'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }).then((x) => x.json())
      if (r.ok) toast({ title: 'Test message delivered', description: r.detail })
      else toast({ title: 'Test failed', description: r.detail || r.error || 'unknown', variant: 'destructive' })
    } catch {
      toast({ title: 'Engine unreachable', variant: 'destructive' })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="space-y-3">
      {/* status row */}
      <div className="flex items-center justify-between text-xs">
        <span className="text-zinc-400">Status</span>
        <div className="flex items-center gap-2">
          {enabled && hasToken && chatId
            ? <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-300 font-mono text-[10px]">● LIVE</Badge>
            : <Badge variant="outline" className="border-zinc-700 bg-zinc-800/50 text-zinc-400 font-mono text-[10px]">○ OFF</Badge>}
          <span className="text-zinc-500 font-mono text-[10px]">{hasToken ? masked : 'no token'}</span>
        </div>
      </div>

      {/* enable toggle */}
      <div className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-950/50 px-3 py-2">
        <div className="space-y-0.5">
          <Label htmlFor="tg-enabled" className="text-xs text-zinc-200">Enable notifications</Label>
          <p className="text-[10px] text-zinc-500">Master switch. Per-event toggles below still apply.</p>
        </div>
        <Switch
          id="tg-enabled"
          checked={enabled}
          onCheckedChange={(v) => {
            setEnabled(v)
            save({ enabled: v })
          }}
          disabled={saving}
        />
      </div>

      {/* chat id */}
      <div className="space-y-1">
        <Label htmlFor="tg-chat" className="text-[11px] text-zinc-400">Chat ID</Label>
        <Input
          id="tg-chat"
          value={chatId}
          onChange={(e) => setChatId(e.target.value)}
          onBlur={() => save({ chatId })}
          placeholder="e.g. -1001234567890 (group) or 123456789 (DM)"
          className="h-8 border-zinc-800 bg-zinc-950 font-mono text-xs text-zinc-100"
        />
      </div>

      {/* bot token */}
      <div className="space-y-1">
        <Label htmlFor="tg-token" className="text-[11px] text-zinc-400">Bot token (from <span className="font-mono">@BotFather</span>)</Label>
        <Input
          id="tg-token"
          type="password"
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          placeholder={hasToken ? `stored — paste new to replace (${masked})` : 'paste bot token, e.g. 123456789:ABCdef…'}
          className="h-8 border-zinc-800 bg-zinc-950 font-mono text-xs text-zinc-100"
        />
        {tokenInput && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => { save({ botToken: tokenInput }); setTokenInput('') }}
            disabled={saving}
            className="h-6 w-full border-zinc-700 text-[10px] text-zinc-300 hover:bg-zinc-800"
          >
            Save new token
          </Button>
        )}
      </div>

      {/* event toggles */}
      <div className="space-y-1.5 rounded-md border border-zinc-800 bg-zinc-950/50 px-3 py-2">
        <p className="text-[10px] uppercase tracking-wide text-zinc-500">Events</p>
        {EVENT_LABELS.map((e) => (
          <div key={e.key} className="flex items-center justify-between">
            <div className="min-w-0">
              <p className="text-xs text-zinc-200">{e.label}</p>
              <p className="truncate text-[10px] text-zinc-500">{e.hint}</p>
            </div>
            <Switch
              checked={events[e.key]}
              onCheckedChange={(v) => {
                const next = { ...events, [e.key]: v }
                setEvents(next)
                save({ events: next })
              }}
              disabled={saving}
            />
          </div>
        ))}
      </div>

      {/* test button */}
      <Button
        size="sm"
        variant="outline"
        onClick={testSend}
        disabled={testing || !hasToken || !chatId}
        className="h-8 w-full border-zinc-700 text-[11px] text-zinc-200 hover:bg-zinc-800 hover:text-emerald-300"
      >
        <Send className="mr-1.5 h-3 w-3" aria-hidden />
        {testing ? 'Sending…' : 'Send test message'}
      </Button>
      {!hasToken && (
        <p className="text-[10px] text-amber-400/80">Configure bot token + chat id first.</p>
      )}
    </div>
  )
}
