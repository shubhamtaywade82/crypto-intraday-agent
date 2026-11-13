'use client'

import { useCallback, useEffect, useState } from 'react'

// Per-viewer UI memory only (tab, symbol, timeframe). Read after mount so the
// server-rendered markup never disagrees with the first client render.
export function usePersistentState<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(fallback)

  useEffect(() => {
    // Hydration-safe: markup must match the server, so stored values apply after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setValue(readStored(key, fallback))
  }, [key])

  const update = useCallback((next: T) => {
    setValue(next)
    try {
      window.localStorage.setItem(key, JSON.stringify(next))
    } catch {
      // private mode or blocked storage: the setting still applies for this session
    }
  }, [key])

  return [value, update] as const
}

export function clearPersistentState(keys: string[]) {
  try {
    keys.forEach((k) => window.localStorage.removeItem(k))
  } catch {
    // storage unavailable: nothing persisted to clear
  }
}

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}
