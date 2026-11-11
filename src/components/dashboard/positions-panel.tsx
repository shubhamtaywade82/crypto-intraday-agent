'use client'

// Positions and trade ledger panel: displays active leveraged contracts with live mark,
// TP/SL brackets, unrealized PnL, manual close trigger, and closed trade audit logs.

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Loader2 } from 'lucide-react'
import type { AccountSnapshot, ClosedTrade, LivePosition } from '@/lib/engine-types'

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false })
}

function fmtNum(val: number, decimals = 2): string {
  return val.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

function calcDuration(start: number, end: number): string {
  const diffSec = Math.max(0, Math.floor((end - start) / 1000))
  if (diffSec < 60) return `${diffSec}s`
  const min = Math.floor(diffSec / 60)
  if (min < 60) return `${min}m`
  return `${Math.floor(min / 60)}h ${min % 60}m`
}

function SideBadge({ side }: { side: string }) {
  const isLong = side === 'LONG'
  return (
    <Badge
      variant="outline"
      className={`font-mono text-[10px] font-semibold ${
        isLong ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' : 'border-rose-500/40 bg-rose-500/10 text-rose-400'
      }`}
    >
      {side}
    </Badge>
  )
}

function PositionRow({ p, onClose, isBusy }: { p: LivePosition; onClose: (s: string) => void; isBusy: boolean }) {
  const isProfit = p.unrealized >= 0
  return (
    <TableRow key={p.id} className="border-b border-zinc-800/70 hover:bg-zinc-900/40">
      <TableCell className="py-2.5 font-mono text-zinc-100">
        <span className="font-semibold">{p.symbol}</span>
        <span className="block text-[10px] text-zinc-500 font-sans">{p.strategy} · conf {(p.confidence * 100).toFixed(0)}%</span>
      </TableCell>
      <TableCell className="py-2.5"><SideBadge side={p.side} /></TableCell>
      <TableCell className="py-2.5 text-right font-mono tabular-nums text-zinc-300">{fmtNum(p.qty, 4)}</TableCell>
      <TableCell className="py-2.5 text-right font-mono tabular-nums text-zinc-400">${fmtNum(p.entry)}</TableCell>
      <TableCell className="py-2.5 text-right font-mono tabular-nums font-semibold text-zinc-100">${fmtNum(p.mark)}</TableCell>
      <TableCell className="py-2.5 text-right font-mono tabular-nums text-xs">
        <span className="text-rose-400">${fmtNum(p.stop)}</span>
        <span className="text-zinc-600 mx-1">/</span>
        <span className="text-emerald-400">${fmtNum(p.takeProfit)}</span>
      </TableCell>
      <TableCell className="py-2.5 text-right font-mono tabular-nums">
        <span className={`inline-block font-semibold ${isProfit ? 'text-emerald-400' : 'text-rose-400'}`}>
          {isProfit ? '+' : ''}${fmtNum(p.unrealized)}
        </span>
        <span className="block text-[10px] opacity-75 font-normal">
          {p.pnlPct >= 0 ? '+' : ''}{p.pnlPct.toFixed(2)}%
        </span>
      </TableCell>
      <TableCell className="py-2.5 text-right">
        <Button
          size="sm"
          variant="outline"
          disabled={isBusy}
          onClick={() => onClose(p.symbol)}
          className="h-7 px-2.5 text-[11px] font-mono border-zinc-700 text-zinc-300 transition-transform active:scale-[0.98] hover:bg-rose-500/10 hover:text-rose-300 hover:border-rose-500/50"
        >
          {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Close'}
        </Button>
      </TableCell>
    </TableRow>
  )
}

function HistoryRow({ trade }: { trade: ClosedTrade }) {
  const isWin = trade.pnl >= 0
  return (
    <TableRow key={trade.id} className="border-b border-zinc-800/70 hover:bg-zinc-900/40">
      <TableCell className="py-2 font-mono text-xs text-zinc-500">{time(trade.closedAt)}</TableCell>
      <TableCell className="py-2 font-mono font-medium text-zinc-200">{trade.symbol}</TableCell>
      <TableCell className="py-2"><SideBadge side={trade.side} /></TableCell>
      <TableCell className="py-2 text-right font-mono tabular-nums text-xs text-zinc-300">
        ${fmtNum(trade.entry)} → ${fmtNum(trade.exit)}
      </TableCell>
      <TableCell className="py-2 text-right font-mono text-[11px] text-zinc-400">
        {calcDuration(trade.openedAt, trade.closedAt)}
      </TableCell>
      <TableCell className="py-2 text-right text-xs text-zinc-400">
        <span className="rounded bg-zinc-900 px-1.5 py-0.5 border border-zinc-800 text-[10px] font-mono">{trade.closeReason}</span>
      </TableCell>
      <TableCell className={`py-2 text-right font-mono tabular-nums font-semibold ${isWin ? 'text-emerald-400' : 'text-rose-400'}`}>
        {isWin ? '+' : ''}${fmtNum(trade.pnl)}
      </TableCell>
    </TableRow>
  )
}

interface Props {
  account: AccountSnapshot
  trades: ClosedTrade[]
  onClose: (symbol: string) => void
  busySymbol: string | null
}

export function PositionsPanel({ account, trades, onClose, busySymbol }: Props) {
  const positions = account.positions ?? []

  return (
    <Tabs defaultValue="positions" className="w-full">
      <TabsList className="bg-zinc-900/90 border border-zinc-800 h-8 p-0.5">
        <TabsTrigger value="positions" className="h-7 text-xs px-3 data-[state=active]:bg-zinc-800 data-[state=active]:text-white">
          Active Positions ({positions.length})
        </TabsTrigger>
        <TabsTrigger value="history" className="h-7 text-xs px-3 data-[state=active]:bg-zinc-800 data-[state=active]:text-white">
          Trade Ledger ({trades.length || account.tradeCount})
        </TabsTrigger>
      </TabsList>

      <TabsContent value="positions" className="mt-3">
        <div className="max-h-72 overflow-y-auto rounded-md border border-zinc-800/80 bg-zinc-950/40">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-zinc-950/95 backdrop-blur border-b border-zinc-800">
              <TableRow className="border-zinc-800 text-[11px] uppercase tracking-wider hover:bg-transparent">
                <TableHead className="text-zinc-400 font-medium py-2">Symbol</TableHead>
                <TableHead className="text-zinc-400 font-medium py-2">Side</TableHead>
                <TableHead className="text-right text-zinc-400 font-medium py-2">Size</TableHead>
                <TableHead className="text-right text-zinc-400 font-medium py-2">Entry</TableHead>
                <TableHead className="text-right text-zinc-400 font-medium py-2">Mark</TableHead>
                <TableHead className="text-right text-zinc-400 font-medium py-2">SL / TP</TableHead>
                <TableHead className="text-right text-zinc-400 font-medium py-2">PnL</TableHead>
                <TableHead className="text-right text-zinc-400 font-medium py-2"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {positions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-sm font-mono text-zinc-500">
                    all positions flat · engine standing by for high-confidence confluences
                  </TableCell>
                </TableRow>
              ) : (
                positions.map((p) => (
                  <PositionRow key={p.id} p={p} onClose={onClose} isBusy={busySymbol === p.symbol} />
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </TabsContent>

      <TabsContent value="history" className="mt-3">
        <div className="max-h-72 overflow-y-auto rounded-md border border-zinc-800/80 bg-zinc-950/40">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-zinc-950/95 backdrop-blur border-b border-zinc-800">
              <TableRow className="border-zinc-800 text-[11px] uppercase tracking-wider hover:bg-transparent">
                <TableHead className="text-zinc-400 font-medium py-2">Time</TableHead>
                <TableHead className="text-zinc-400 font-medium py-2">Symbol</TableHead>
                <TableHead className="text-zinc-400 font-medium py-2">Side</TableHead>
                <TableHead className="text-right text-zinc-400 font-medium py-2">Execution</TableHead>
                <TableHead className="text-right text-zinc-400 font-medium py-2">Duration</TableHead>
                <TableHead className="text-right text-zinc-400 font-medium py-2">Reason</TableHead>
                <TableHead className="text-right text-zinc-400 font-medium py-2">Realized</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {trades.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-sm font-mono text-zinc-500">
                    no historical executions recorded yet
                  </TableCell>
                </TableRow>
              ) : (
                trades.map((trade) => <HistoryRow key={trade.id} trade={trade} />)
              )}
            </TableBody>
          </Table>
        </div>
      </TabsContent>
    </Tabs>
  )
}

export default PositionsPanel
