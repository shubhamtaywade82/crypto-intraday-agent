'use client'

// Market watch table: top USDT-M perps with live prices, funding, OI, spread,
// INR reference and the composite signal badge. Row click selects the chart symbol.

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import type { TickerRow } from '@/lib/engine-types'

const fmtPrice = (n: number) =>
  n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 1 }) : n >= 1 ? n.toFixed(3) : n.toPrecision(4)
const fmtVol = (n: number) => (n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : (n / 1e6).toFixed(1) + 'M')

function CompositeBadge({ composite }: { composite: number | null | undefined }) {
  if (composite === null || composite === undefined) {
    return <span className="text-xs text-zinc-600">—</span>
  }
  const strong = Math.abs(composite) >= 0.45
  const cls =
    composite > 0
      ? strong ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40' : 'bg-emerald-500/10 text-emerald-500/90 border-emerald-500/20'
      : strong ? 'bg-red-500/15 text-red-400 border-red-500/40' : 'bg-red-500/10 text-red-500/90 border-red-500/20'
  const label = composite > 0 ? 'LONG' : 'SHORT'
  return (
    <Badge variant="outline" className={`${cls} font-mono text-[10px]`}>
      {label} {Math.abs(composite).toFixed(2)}
    </Badge>
  )
}

interface Props {
  rows: TickerRow[]
  selected: string
  onSelect: (symbol: string) => void
  positionSymbols: Set<string>
}

export function MarketTable({ rows, selected, onSelect, positionSymbols }: Props) {
  return (
    <div className="max-h-[420px] overflow-y-auto">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-zinc-950/95 backdrop-blur">
          <TableRow className="hover:bg-transparent border-zinc-800">
            <TableHead className="text-zinc-400 font-medium">Symbol</TableHead>
            <TableHead className="text-right text-zinc-400 font-medium">Price</TableHead>
            <TableHead className="text-right text-zinc-400 font-medium">24h</TableHead>
            <TableHead className="hidden sm:table-cell text-right text-zinc-400 font-medium">Funding</TableHead>
            <TableHead className="hidden md:table-cell text-right text-zinc-400 font-medium">OI 15m</TableHead>
            <TableHead className="hidden lg:table-cell text-right text-zinc-400 font-medium">CDCX Δ</TableHead>
            <TableHead className="hidden lg:table-cell text-right text-zinc-400 font-medium">INR ref</TableHead>
            <TableHead className="text-right text-zinc-400 font-medium">Signal</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={8} className="text-center text-zinc-500 py-8 text-sm">
                waiting for market data…
              </TableCell>
            </TableRow>
          )}
          {rows.map((t) => {
            const isSel = t.symbol === selected
            return (
              <TableRow
                key={t.symbol}
                onClick={() => onSelect(t.symbol)}
                className={`cursor-pointer border-zinc-800/70 transition-colors ${
                  isSel ? 'bg-zinc-900' : 'hover:bg-zinc-900/60'
                }`}
                aria-selected={isSel}
              >
                <TableCell className="font-mono font-medium text-zinc-100">
                  <span className="flex items-center gap-1.5">
                    {positionSymbols.has(t.symbol) && (
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400" aria-label="open position" />
                    )}
                    {t.symbol.replace('USDT', '')}
                    <span className="text-[10px] text-zinc-600">/USDT</span>
                  </span>
                </TableCell>
                <TableCell className="text-right font-mono text-zinc-100">{fmtPrice(t.price)}</TableCell>
                <TableCell className={`text-right font-mono ${t.changePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {t.changePct >= 0 ? '+' : ''}
                  {(t.changePct * 100).toFixed(2)}%
                </TableCell>
                <TableCell className={`hidden sm:table-cell text-right font-mono text-xs ${
                  t.fundingRate > 0 ? 'text-emerald-500/80' : 'text-red-500/80'
                }`}>
                  {(t.fundingRate * 100).toFixed(4)}%
                </TableCell>
                <TableCell className={`hidden md:table-cell text-right font-mono text-xs ${
                  (t.oiChangePct ?? 0) >= 0 ? 'text-emerald-500/80' : 'text-red-500/80'
                }`}>
                  {t.oiChangePct === null ? '—' : `${t.oiChangePct >= 0 ? '+' : ''}${t.oiChangePct.toFixed(2)}%`}
                </TableCell>
                <TableCell className="hidden lg:table-cell text-right font-mono text-xs text-zinc-400">
                  {t.spreadPct === null ? (
                    <span className="text-zinc-600" title="CoinDCX unreachable — see status pill">n/a</span>
                  ) : (
                    `${t.spreadPct >= 0 ? '+' : ''}${t.spreadPct.toFixed(2)}%`
                  )}
                </TableCell>
                <TableCell className="hidden lg:table-cell text-right font-mono text-xs text-zinc-400">
                  {t.inrPrice === null ? '—' : `₹${fmtPrice(t.inrPrice)}`}
                  {t.inrSource === 'derived' && <span className="ml-1 text-[9px] text-zinc-600">*</span>}
                </TableCell>
                <TableCell className="text-right">
                  <CompositeBadge composite={t.signals?.composite} />
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

export default MarketTable
