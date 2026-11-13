'use client'

// Market watch table: live Binance USDT-M perp prices, 24h momentum, funding rates,
// 15m open interest shifts, cross-exchange CoinDCX spread, and multi-family signal scores.

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import type { TickerRow } from '@/lib/engine-types'

function fmtPrice(val: number): string {
  if (val >= 1000) return val.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 2 })
  if (val >= 1) return val.toFixed(3)
  return val.toPrecision(4)
}

function SignalBadge({ score }: { score: number | null | undefined }) {
  if (score === null || score === undefined) {
    return <span className="font-mono text-xs text-zinc-600">—</span>
  }
  const isLong = score > 0
  const isHighConf = Math.abs(score) >= 0.45
  const colorCls = isLong
    ? isHighConf ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300' : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-400'
    : isHighConf ? 'border-rose-500/50 bg-rose-500/15 text-rose-300' : 'border-rose-500/25 bg-rose-500/10 text-rose-400'

  return (
    <Badge variant="outline" className={`inline-flex items-center gap-1 font-mono text-[10px] tabular-nums ${colorCls}`}>
      {isLong ? <ArrowUpRight className="h-3 w-3" aria-hidden /> : <ArrowDownRight className="h-3 w-3" aria-hidden />}
      <span>{isLong ? 'LONG' : 'SHORT'}</span>
      <span className="font-semibold">{Math.abs(score).toFixed(2)}</span>
    </Badge>
  )
}

interface RowProps {
  ticker: TickerRow
  selected: boolean
  hasPosition: boolean
  onSelect: (symbol: string) => void
}

function TickerItem({ ticker, selected, hasPosition, onSelect }: RowProps) {
  const isUp = ticker.changePct >= 0
  const oiUp = (ticker.oiChangePct ?? 0) >= 0

  return (
    <TableRow
      onClick={() => onSelect(ticker.symbol)}
      aria-selected={selected}
      className={`cursor-pointer border-b border-zinc-800/60 transition-colors duration-150 active:scale-[0.99] ${
        selected ? 'bg-zinc-900 border-l-2 border-l-emerald-500 text-white' : 'hover:bg-zinc-900/60 text-zinc-300'
      }`}
    >
      <TableCell className="py-2.5 font-mono font-medium">
        <span className="flex items-center gap-1.5">
          {hasPosition && <span className="h-2 w-2 rounded-full bg-amber-400 shadow-sm shadow-amber-500/50" title="Active position" />}
          <span className="text-zinc-100">{ticker.symbol.replace('USDT', '')}</span>
          <span className="text-[10px] text-zinc-500 font-normal">/USDT</span>
        </span>
      </TableCell>
      <TableCell className="py-2.5 text-right font-mono tabular-nums font-semibold text-zinc-100">
        ${fmtPrice(ticker.price)}
      </TableCell>
      <TableCell className="py-2.5 text-right font-mono tabular-nums">
        <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${
          isUp ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'
        }`}>
          {isUp ? '+' : ''}{(ticker.changePct * 100).toFixed(2)}%
        </span>
      </TableCell>
      <TableCell className={`hidden 2xl:table-cell py-2.5 text-right font-mono tabular-nums text-xs ${
        ticker.fundingRate > 0 ? 'text-zinc-400' : 'text-amber-400 font-semibold'
      }`}>
        {(ticker.fundingRate * 100).toFixed(4)}%
      </TableCell>
      <TableCell className={`hidden 2xl:table-cell py-2.5 text-right font-mono tabular-nums text-xs ${
        oiUp ? 'text-emerald-400/90' : 'text-rose-400/90'
      }`}>
        {ticker.oiChangePct === null ? '—' : `${oiUp ? '+' : ''}${ticker.oiChangePct.toFixed(2)}%`}
      </TableCell>
      <TableCell className="hidden 2xl:table-cell py-2.5 text-right font-mono tabular-nums text-xs text-zinc-400">
        {ticker.spreadPct === null ? <span className="text-zinc-600">n/a</span> : `${ticker.spreadPct >= 0 ? '+' : ''}${ticker.spreadPct.toFixed(2)}%`}
      </TableCell>
      <TableCell className="hidden 2xl:table-cell py-2.5 text-right font-mono tabular-nums text-xs text-zinc-400">
        {ticker.inrPrice === null ? '—' : `₹${fmtPrice(ticker.inrPrice)}`}
        {ticker.inrSource === 'derived' && <span className="ml-0.5 text-[9px] text-zinc-500" title="Derived via USDT/INR reference rate">*</span>}
      </TableCell>
      <TableCell className="py-2.5 text-right">
        <SignalBadge score={ticker.signals?.composite} />
      </TableCell>
    </TableRow>
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
    <div>
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-zinc-950/95 backdrop-blur border-b border-zinc-800">
          <TableRow className="hover:bg-transparent border-zinc-800 text-[11px] uppercase tracking-wider">
            <TableHead className="text-zinc-400 font-medium py-2">Symbol</TableHead>
            <TableHead className="text-right text-zinc-400 font-medium py-2">Price</TableHead>
            <TableHead className="text-right text-zinc-400 font-medium py-2">24h</TableHead>
            <TableHead className="hidden 2xl:table-cell text-right text-zinc-400 font-medium py-2">Funding</TableHead>
            <TableHead className="hidden 2xl:table-cell text-right text-zinc-400 font-medium py-2">OI 15m</TableHead>
            <TableHead className="hidden 2xl:table-cell text-right text-zinc-400 font-medium py-2">CDCX Δ</TableHead>
            <TableHead className="hidden 2xl:table-cell text-right text-zinc-400 font-medium py-2">INR ref</TableHead>
            <TableHead className="text-right text-zinc-400 font-medium py-2">Signal</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={8} className="py-8 text-center text-sm text-zinc-500 font-mono">
                connecting to live market feed…
              </TableCell>
            </TableRow>
          ) : (
            rows.map((ticker) => (
              <TickerItem
                key={ticker.symbol}
                ticker={ticker}
                selected={ticker.symbol === selected}
                hasPosition={positionSymbols.has(ticker.symbol)}
                onSelect={onSelect}
              />
            ))
          )}
        </TableBody>
      </Table>
    </div>
  )
}

export default MarketTable
