// ─── Small utilities: resilient fetch, sleep, ids, formatting ────────────────

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function uid(prefix = 'p'): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

export function num(x: unknown, fallback = 0): number {
  const n = typeof x === 'number' ? x : parseFloat(String(x))
  return Number.isFinite(n) ? n : fallback
}

export interface FetchOptions extends RequestInit {
  timeoutMs?: number
  retries?: number
  backoffMs?: number
}

/** fetch with timeout, retries and exponential backoff; throws on persistent failure */
export async function fetchJson<T = any>(url: string, opts: FetchOptions = {}): Promise<T> {
  const { timeoutMs = 12_000, retries = 2, backoffMs = 1_200, ...init } = opts
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        ...init,
        signal: ctrl.signal,
        headers: {
          accept: 'application/json',
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
          ...(init.headers || {}),
        },
      })
      clearTimeout(timer)
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
      const text = await res.text()
      // Cloudflare challenge pages come back as HTML with 200 sometimes
      if (text.trimStart().startsWith('<')) throw new Error('blocked (html challenge page)')
      return JSON.parse(text) as T
    } catch (e) {
      clearTimeout(timer)
      lastErr = e
      if (attempt < retries) await sleep(backoffMs * (attempt + 1))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

export const fmtUsd = (n: number, digits = 2) =>
  n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })

export const fmtPct = (n: number, digits = 2) => `${n >= 0 ? '+' : ''}${(n * 100).toFixed(digits)}%`

export const nowMs = () => Date.now()

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}
