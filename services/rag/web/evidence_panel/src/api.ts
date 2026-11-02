import type { Audit, Health, RecentItem } from './types'

const params = new URLSearchParams(window.location.search)
const token = params.get('token') ?? window.localStorage.getItem('bah-panel-token') ?? ''
if (params.get('token')) {
  window.localStorage.setItem('bah-panel-token', params.get('token') as string)
}

function headers(): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function request<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: headers() })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`${response.status} ${response.statusText} · ${detail.slice(0, 160)}`)
  }
  return (await response.json()) as T
}

export function fetchHealth(): Promise<Health> {
  return request<Health>('/healthz')
}

export function fetchRecent(limit = 20): Promise<RecentItem[]> {
  return request<RecentItem[]>(`/v1/audit/recent?limit=${limit}`)
}

export function fetchAudit(traceId: string): Promise<Audit> {
  return request<Audit>(`/v1/audit/${encodeURIComponent(traceId)}`)
}
