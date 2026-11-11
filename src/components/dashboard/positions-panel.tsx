'use client'

// Open positions (live PnL, close buttons) + closed trade history in tabs.

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { AccountSnapshot, ClosedTrade, LivePosition } from '@/lib/engine-types'

const time = (ts: number) => new Date(ts).toLocaleTimeString('en-GB', { hour12: false })
const num = (n: number, d = 4) => n.toLocaleString('en-US', { maximumFractionDigits: d })

function SideBadge({ side }: { side: string }) {
  return (
    <Badge variant="outline" className={side === 'LONG' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400 font-mono text-[10px]' : 'border-red-500/40 bg-red-500/10 text-red-400 font-mono text-[10px]'}>
      {side}
    </Badge>
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
      <TabsList className="bg-zinc-900 border border-zinc-800">
        <TabsTrigger value="positions" className="data-[state=active]:bg-zinc-800 text-zinc-300 text-xs">
          Open ({positions.length})
        </TabsTrigger>
        <TabsTrigger value="history" className="data-[state=active]:bg-zinc-800 text-zinc-300 text-xs">
          History ({account.tradeCount})
        </TabsTrigger>
      </TabsList>

      <TabsContent value="positions" className="mt-3">
        <div className="max-h-72 overflow-y-auto rounded-md border border-zinc-800">
          <Table>
            <TableHeader className="sticky top-0 bg-zinc-950/95 backdrop-blur">
              <TableRow className="border-zinc-800 hover:bg-transparent">
                <TableHead className="text-zinc-400 font-medium">Symbol</TableHead>
                <TableHead className="text-zinc-400 font-medium">Side</TableHead>
                <TableHead className="text-right text-zinc-400 font-medium">Qty</TableHead>
                <TableHead className="text-right text-zinc-400 font-medium">Entry</TableHead>
                <TableHead className="text-right text-zinc-400 font-medium">Mark</TableHead>
                <TableHead className="text-right text-zinc-400 font-medium">SL / TP</TableHead>
                <TableHead className="text-right text-zinc-400 font-medium">PnL</TableHead>
                <TableHead className="text-right text-zinc-400 font-medium"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {positions.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-zinc-500 py-6 text-sm">
                    flat — the agent opens positions when multi-family signals align
                  </TableCell>
                </TableRow>
              )}
              {positions.map((p: LivePosition) => (
                <TableRow key={p.id} className="border-zinc-800/70">
                  <TableCell className="font-mono text-zinc-100">
                    {p.symbol}
                    <span className="block text-[10px] text-zinc-600">{p.strategy} · conf {(p.confidence * 100).toFixed(0)}%</span>
                  </TableCell>
                  <TableCell><SideBadge side={p.side} /></TableCell>
                  <TableCell className="text-right font-mono text-zinc-300">{num(p.qty, 6)}</TableCell>
                  <TableCell className="text-right font-mono text-zinc-300">{num(p.entry)}</TableCell>
                  <TableCell className="text-right font-mono text-zinc-100">{num(p.mark)}</TableCell>
                  <TableCell className="text-right font-mono text-xs text-zinc-500">
                    {num(p.stop, 2)} / {num(p.takeProfit, 2)}
                  </TableCell>
                  <TableCell className={`text-right font-mono ${p.unrealized >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {p.unrealized >= 0 ? '+' : ''}{p.unrealized.toFixed(2)}
                    <span className="block text-[10px] opacity-70">{p.pnlPct >= 0 ? '+' : ''}{p.pnlPct}%</span>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busySymbol === p.symbol}
                      onClick={() => onClose(p.symbol)}
                      className="h-7 px-2 text-[11px] border-zinc-700 text-zinc-300 hover:bg-red-500/10 hover:text-red-300 hover:border-red-500/40"
                    >
                      {busySymbol === p.symbol ? '…' : 'Close'}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </TabsContent>

      <TabsContent value="history" className="mt-3">
        <div className="max-h-72 overflow-y-auto rounded-md border border-zinc-800">
          <Table>
            <TableHeader className="sticky top-0 bg-zinc-950/95 backdrop-blur">
              <TableRow className="border-zinc-800 hover:bg-transparent">
                <TableHead className="text-zinc-400 font-medium">Closed</TableHead>
                <TableHead className="text-zinc-400 font-medium">Symbol</TableHead>
                <TableHead className="text-zinc-400 font-medium">Side</TableHead>
                <TableHead className="text-right text-zinc-400 font-medium">Entry → Exit</TableHead>
                <TableHead className="text-right text-zinc-400 font-medium">Reason</TableHead>
                <TableHead className="text-right text-zinc-400 font-medium">PnL</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {trades.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-zinc-500 py-6 text-sm">
                    no closed trades yet — history fills as TP/SL brackets resolve
                  </TableCell>
                </TableRow>
              )}
              {trades.map((t) => (
                <TableRow key={t.id} className="border-zinc-800/70">
                  <TableCell className="font-mono text-xs text-zinc-500">{time(t.closedAt)}</TableCell>
                  <TableCell className="font-mono text-zinc-200">{t.symbol}</TableCell>
                  <TableCell><SideBadge side={t.side} /></TableCell>
                  <TableCell className="text-right font-mono text-xs text-zinc-400">{num(t.entry, 2)} → {num(t.exit, 2)}</TableCell>
                  <TableCell className="text-right text-xs text-zinc-500">{t.closeReason}</TableCell>
                  <TableCell className={`text-right font-mono ${t.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {t.pnl >= 0 ? '+' : ''}{t.pnl.toFixed(2)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </TabsContent>
    </Tabs>
  )
}

export default PositionsPanel
