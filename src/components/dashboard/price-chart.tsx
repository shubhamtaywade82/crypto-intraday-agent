'use client'

import { useEffect, useRef } from 'react'
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import type { Candle } from '@/lib/engine-types'

interface Props {
  candles: Candle[]
  symbol: string
  tf: string
}

function ema(values: number[], period: number): number[] {
  const out: number[] = []
  const k = 2 / (period + 1)
  let prev: number | null = null
  for (const v of values) {
    prev = prev === null ? v : v * k + prev * (1 - k)
    out.push(prev)
  }
  return out
}

export function PriceChart({ candles, symbol, tf }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const ema9Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const ema21Ref = useRef<ISeriesApi<'Line'> | null>(null)

  // create chart once
  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: 'transparent' },
        textColor: '#a1a1aa',
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(63,63,70,0.35)' },
        horzLines: { color: 'rgba(63,63,70,0.35)' },
      },
      rightPriceScale: { borderColor: 'rgba(63,63,70,0.6)' },
      timeScale: { borderColor: 'rgba(63,63,70,0.6)', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 1 },
      autoSize: true,
    })
    chartRef.current = chart
    candleRef.current = chart.addSeries(CandlestickSeries, {
      upColor: '#10b981',
      downColor: '#ef4444',
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444',
      borderVisible: false,
    })
    ema9Ref.current = chart.addSeries(LineSeries, {
      color: '#f59e0b',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    })
    ema21Ref.current = chart.addSeries(LineSeries, {
      color: '#e879f9',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    })
    return () => {
      chart.remove()
      chartRef.current = null
    }
  }, [])

  // (re)load data when symbol/tf/candles change
  useEffect(() => {
    if (!candleRef.current || !candles.length) return
    const bars = candles.map((c) => ({
      time: (c.t / 1000) as UTCTimestamp,
      open: c.o,
      high: c.h,
      low: c.l,
      close: c.c,
    }))
    candleRef.current.setData(bars)

    const closes = candles.map((c) => c.c)
    const e9 = ema(closes, 9)
    const e21 = ema(closes, 21)
    ema9Ref.current?.setData(candles.map((c, i) => ({ time: (c.t / 1000) as UTCTimestamp, value: e9[i] })))
    ema21Ref.current?.setData(candles.map((c, i) => ({ time: (c.t / 1000) as UTCTimestamp, value: e21[i] })))

    chartRef.current?.timeScale().scrollToRealTime()
  }, [candles, symbol, tf])

  return (
    <div
      ref={containerRef}
      className="h-[340px] w-full sm:h-[400px]"
      role="img"
      aria-label={`${symbol} ${tf} candlestick chart with EMA 9 and EMA 21 overlays`}
    />
  )
}

export default PriceChart
