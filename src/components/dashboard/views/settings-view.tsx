'use client'

import { Send, Settings2, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { TelegramPanel } from '@/components/dashboard/telegram-panel'
import { Panel } from '@/components/dashboard/panel'
import type { EngineFeed } from '@/hooks/use-engine-feed'

interface Props {
  feed: EngineFeed
  restoreLastView: boolean
  onRestoreLastView: (value: boolean) => void
  onResetPreferences: () => void
}

// Settings persist in two places: Telegram lives in the engine, display preferences in this browser.
export function SettingsView({ feed, restoreLastView, onRestoreLastView, onResetPreferences }: Props) {
  const { risk } = feed
  return (
    <div className="grid gap-2 lg:h-full lg:min-h-0 lg:grid-cols-2">
      <Panel title="Telegram alerts" icon={<Send className="h-4 w-4 text-sky-400" aria-hidden />}>
        <TelegramPanel config={feed.telegram} />
      </Panel>

      <div className="flex min-h-0 flex-col gap-2 lg:h-full">
        <Panel title="Preferences" icon={<Settings2 className="h-4 w-4 text-zinc-500" aria-hidden />} scroll={false} className="shrink-0">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs text-zinc-200">Reopen last view</p>
              <p className="text-[11px] text-zinc-500">Open the tab you used last. Symbol and timeframe are always remembered.</p>
            </div>
            <Switch checked={restoreLastView} onCheckedChange={onRestoreLastView} aria-label="Reopen last view on load" />
          </div>
          <Button size="sm" variant="outline" onClick={onResetPreferences} className="mt-3 h-7 w-full border-zinc-700 text-[11px] text-zinc-400 hover:bg-zinc-800">
            Reset saved layout
          </Button>
        </Panel>

        <Panel title="Guardrails (read-only)" icon={<ShieldCheck className="h-4 w-4 text-amber-400" aria-hidden />} className="flex-1">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 font-mono text-xs">
            <Row label="Risk per trade" value={`${(risk.riskPerTradePct * 100).toFixed(1)}% equity`} />
            <Row label="Daily loss cutoff" value={`${(risk.dailyLossCutoffPct * 100).toFixed(1)}%`} />
            <Row label="Max positions" value={String(risk.maxPositions)} />
            <Row label="Max leverage" value={`${risk.maxLeverage}×`} />
            <Row label="Confidence floor" value={`${(risk.minConfidence * 100).toFixed(0)}%`} />
            <Row label="Halt" value={risk.haltedReason || 'none'} />
          </dl>
          <p className="mt-4 text-[11px] leading-relaxed text-zinc-500">
            These are hard limits set in <span className="font-mono text-zinc-400">mini-services/engine/src/config.ts</span>.
            Change them there and restart the engine.
          </p>
        </Panel>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className="mt-0.5 text-zinc-200">{value}</dd>
    </div>
  )
}

export default SettingsView
