'use client'

// High-performance candlestick chart with EMA9/EMA21 overlays, volume histogram,
// and realtime crosshair OHLCV inspection powered by TradingView lightweight-charts.

import { useEffect, useRef, useState } from 'react'
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  type MouseEventParams,
} from 'lightweight-charts'
import type { Candle } from '@/lib/engine-types'

interface Props {
  candles: Candle[]
  symbol: string
  tf: string
}

interface LegendData {
  open: number
  high: number
  low: number
  close: number
  volume: number
  isUp: boolean
}

function calcEma(values: number[], period: number): number[] {
  const result: number[] = []
  const multiplier = 2 / (period + 1)
  let prev: number | null = null
  for (const val of values) {
    prev = prev === null ? val : val * multiplier + prev * (1 - multiplier)
    result.push(prev)
  }
  return result
}

function fmtPrice(val: number): string {
  if (val >= 1000) return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (val >= 1) return val.toFixed(3)
  return val.toPrecision(4)
}

function fmtVolume(val: number): string {
  if (val >= 1e6) return `${(val / 1e6).toFixed(2)}M`
  if (val >= 1e3) return `${(val / 1e3).toFixed(1)}K`
  return val.toFixed(0)
}

function createBaseChart(container: HTMLDivElement): IChartApi {
  return createChart(container, {
    layout: { background: { color: 'transparent' }, textColor: '#71717a', fontSize: 11, attributionLogo: false },
    grid: { vertLines: { color: 'rgba(39, 39, 42, 0.45)' }, horzLines: { color: 'rgba(39, 39, 42, 0.45)' } },
    rightPriceScale: { borderColor: 'rgba(63, 63, 70, 0.5)', scaleMargins: { top: 0.1, bottom: 0.22 } },
    timeScale: { borderColor: 'rgba(63, 63, 70, 0.5)', timeVisible: true, secondsVisible: false },
    crosshair: {
      vertLine: { color: 'rgba(161, 161, 170, 0.35)', width: 1, style: 3 },
      horzLine: { color: 'rgba(161, 161, 170, 0.35)', width: 1, style: 3 },
    },
    autoSize: true,
  })
}

function addChartSeries(chart: IChartApi) {
  const candle = chart.addSeries(CandlestickSeries, {
    upColor: '#10b981', downColor: '#ef4444', wickUpColor: '#10b981', wickDownColor: '#ef4444', borderVisible: false,
  })
  const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'volume' })
  chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } })
  const ema9 = chart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
  const ema21 = chart.addSeries(LineSeries, { color: '#c084fc', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
  return { candle, volume, ema9, ema21 }
}

function attachCrosshair(
  chart: IChartApi,
  candle: ISeriesApi<'Candlestick'>,
  volume: ISeriesApi<'Histogram'>,
  onLegend: (d: LegendData | null) => void,
) {
  chart.subscribeCrosshairMove((param: MouseEventParams) => {
    if (!param.time) return onLegend(null)
    const cData = param.seriesData.get(candle) as { open?: number; high?: number; low?: number; close?: number } | undefined
    if (cData?.open === undefined || cData.close === undefined) return onLegend(null)
    const vData = param.seriesData.get(volume) as { value?: number } | undefined
    onLegend({
      open: cData.open, high: cData.high ?? cData.open, low: cData.low ?? cData.open,
      close: cData.close, volume: vData?.value ?? 0, isUp: cData.close >= cData.open,
    })
  })
}

function syncChartData(
  candles: Candle[],
  candle: ISeriesApi<'Candlestick'>,
  volume: ISeriesApi<'Histogram'>,
  ema9: ISeriesApi<'Line'>,
  ema21: ISeriesApi<'Line'>,
) {
  candle.setData(candles.map((c) => ({
    time: (c.t / 1000) as UTCTimestamp, open: c.o, high: c.h, low: c.l, close: c.c,
  })))
  volume.setData(candles.map((c) => ({
    time: (c.t / 1000) as UTCTimestamp, value: c.v,
    color: c.c >= c.o ? 'rgba(16, 185, 129, 0.35)' : 'rgba(239, 68, 68, 0.35)',
  })))
  const closes = candles.map((c) => c.c)
  const e9 = calcEma(closes, 9)
  const e21 = calcEma(closes, 21)
  ema9.setData(candles.map((c, i) => ({ time: (c.t / 1000) as UTCTimestamp, value: e9[i] })))
  ema21.setData(candles.map((c, i) => ({ time: (c.t / 1000) as UTCTimestamp, value: e21[i] })))
}

export function PriceChart({ candles, symbol, tf }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ReturnType<typeof addChartSeries> | null>(null)
  const [legend, setLegend] = useState<LegendData | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createBaseChart(containerRef.current)
    const series = addChartSeries(chart)
    chartRef.current = chart
    seriesRef.current = series
    attachCrosshair(chart, series.candle, series.volume, setLegend)
    return () => { chart.remove(); chartRef.current = null; seriesRef.current = null }
  }, [])

  useEffect(() => {
    if (!seriesRef.current || !candles.length) return
    const { candle, volume, ema9, ema21 } = seriesRef.current
    syncChartData(candles, candle, volume, ema9, ema21)
    chartRef.current?.timeScale().scrollToRealTime()
  }, [candles, symbol, tf])

  const latest = candles[candles.length - 1]
  const display = legend || (latest ? {
    open: latest.o, high: latest.h, low: latest.l, close: latest.c, volume: latest.v, isUp: latest.c >= latest.o,
  } : null)

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col">
      {display && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 pb-2 text-[11px] font-mono tabular-nums text-zinc-400">
          <span>O <strong className="font-semibold text-zinc-200">{fmtPrice(display.open)}</strong></span>
          <span>H <strong className="font-semibold text-zinc-200">{fmtPrice(display.high)}</strong></span>
          <span>L <strong className="font-semibold text-zinc-200">{fmtPrice(display.low)}</strong></span>
          <span>C <strong className={display.isUp ? 'text-emerald-400 font-semibold' : 'text-red-400 font-semibold'}>{fmtPrice(display.close)}</strong></span>
          <span>Vol <strong className="font-semibold text-zinc-300">{fmtVolume(display.volume)}</strong></span>
        </div>
      )}
      <div
        ref={containerRef}
        className="min-h-[300px] w-full flex-1"
        role="img"
        aria-label={`${symbol} ${tf} candlestick chart with EMA 9, EMA 21, and volume overlays`}
      />
    </div>
  )
}

export default PriceChart
