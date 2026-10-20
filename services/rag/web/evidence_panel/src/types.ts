export type Verdict =
  | 'GREEN'
  | 'AMBER_INFERRED'
  | 'AMBER_DISAMBIGUATION'
  | 'RED'
  | 'LOCKED'

export interface Principal {
  role: string
  audience: string
  channel: string
  region: string
  product_id?: string | null
  now: string
}

export interface RetrievalLog {
  trace_id: string
  session_id: string
  query_norm: string
  predicate_json: string
  visible_count: number
  evidence_ids: string
  route: string
  verdict: string
  reason_code: string | null
  latency_ms: number
  created_at: string
  channels_json: string | null
  breaker_state: string | null
  cache_hit: number
}

export interface AnswerLog {
  trace_id: string
  answer_text: string
  verdict: string
  reason_code: string | null
  tokens_in: number
  tokens_out: number
  latency_ms: number
  verify_json: string | null
  generator: string | null
  model: string | null
}

export interface BreakerRow {
  session_id: string
  consecutive_red: number
  injection_hits: number
  locked_until: number
  last_reason: string | null
  updated_at: string
}

export interface BreakerEvent {
  log_id: number
  session_id: string
  event: string
  reason: string | null
  actor: string | null
  locked_until: number
  created_at: string
}

export interface EvidenceItem {
  chunkId: number
  docId: string
  title: string
  clauseNo: string | null
  tier: number
  text: string
}

export interface Audit {
  traceId: string
  retrieval: RetrievalLog | null
  answer: AnswerLog | null
  breaker: BreakerRow | null
  breakerEvents: BreakerEvent[]
  evidence: EvidenceItem[]
}

export interface RecentItem {
  trace_id: string
  session_id: string
  query_norm: string
  visible_count: number
  route: string
  verdict: string
  reason_code: string | null
  latency_ms: number
  created_at: string
  generator: string | null
  model: string | null
}

export interface ChannelHit {
  chunkId: number
  rank: number
  score: number
}

export interface FusedHit {
  chunkId: number
  score: number
  tier: number
  tierWeight: number
  ranks: Record<string, number>
  rawScores: Record<string, number>
}

export interface LookupCell {
  cellId: number
  chunkId: number
  label: string
  valueText: string
  unit: string
}

export interface ChannelTrace {
  rrfK?: number
  terms?: string[]
  route?: string
  fts5?: ChannelHit[]
  vector?: ChannelHit[]
  fused?: FusedHit[]
  cells?: LookupCell[]
  vectorError?: string | null
}

export interface VerifyClaim {
  index: number
  text: string
  markers: string[]
  literal: 'pass' | 'fail'
  support: 'pass' | 'fail'
  entailment: 'pass' | 'fail' | 'skipped'
}

export interface VerifyNumber {
  raw: string
  valueText: string
  unit: string
  source: string
  match: boolean
}

export interface Citation {
  marker: string
  docId: string
  title: string
  clauseNo: string | null
  charStart: number
  charEnd: number
}

export interface VerifyPayload {
  verdict: Verdict
  reasonCode: string | null
  claims: VerifyClaim[]
  numbers: VerifyNumber[]
  citations: Citation[]
}

export interface Health {
  status: string
  schemaVersion: string
  corpusVersion: number
  embedVersion: string
  docs: number
  chunks: number
  embedding: 'on' | 'off'
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
