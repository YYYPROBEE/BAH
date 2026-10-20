import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchAudit, fetchHealth, fetchRecent } from './api'
import type {
  Audit,
  ChannelTrace,
  Citation,
  EvidenceItem,
  Health,
  RecentItem,
  Verdict,
  VerifyPayload,
} from './types'
import { parseJson } from './types'

const VERDICT_LABEL: Record<Verdict, string> = {
  GREEN: 'GREEN · 双通过',
  AMBER_INFERRED: 'AMBER · 推断性',
  AMBER_DISAMBIGUATION: 'AMBER · 待消歧',
  RED: 'RED · 拒答',
  LOCKED: 'LOCKED · 熔断',
}

const REASON_LABEL: Record<string, string> = {
  SCOPE_EMPTY: '权限范围内无依据',
  EMPTY_RETRIEVAL: '库内无相关依据',
  INSUFFICIENT_EVIDENCE: '证据不足',
  NUMERIC_MISMATCH: '数值不一致',
  SPAN_UNRESOLVED: '引用不可解析',
  MISSING_CITATION: '缺少引用',
  MISSING_CLAIM_CITATION: '结论未绑定引用',
  UNSUPPORTED_CLAIM: '结论无证据支持',
  BREAKER_LOCKED: '会话已锁定',
  NEED_DISAMBIGUATION: '产品待消歧',
}

const GENERATOR_LABEL: Record<string, string> = {
  llm: 'LLM 生成',
  template: '取数模板',
  extractive: '抽取式',
  'extractive-fallback': '抽取式（LLM 降级）',
  none: '未生成',
}

function verdictClass(verdict: string): string {
  return `badge badge-${verdict.toLowerCase().replace(/_/g, '-')}`
}

function timeOf(iso: string | null | undefined): string {
  if (!iso) return '—'
  return iso.length >= 19 ? iso.slice(11, 19) : iso
}

function epochTime(value: number): string {
  if (!value) return '—'
  return new Date(value * 1000).toLocaleTimeString('zh-CN', { hour12: false })
}

function Highlight({ text, spans }: { text: string; spans: Citation[] }) {
  if (!spans.length) return <>{text}</>
  const sorted = [...spans].sort((a, b) => a.charStart - b.charStart)
  const parts: React.ReactNode[] = []
  let cursor = 0
  sorted.forEach((span, index) => {
    const start = Math.max(cursor, Math.min(span.charStart, text.length))
    const end = Math.max(start, Math.min(span.charEnd, text.length))
    if (start > cursor) parts.push(<span key={`t-${index}`}>{text.slice(cursor, start)}</span>)
    if (end > start) {
      parts.push(
        <mark key={`m-${index}`} title={`${span.marker} · ${span.docId}`}>
          {text.slice(start, end)}
        </mark>,
      )
    }
    cursor = end
  })
  if (cursor < text.length) parts.push(<span key="tail">{text.slice(cursor)}</span>)
  return <>{parts}</>
}

function VerdictBadge({ verdict }: { verdict: string }) {
  return <span className={verdictClass(verdict)}>{VERDICT_LABEL[verdict as Verdict] ?? verdict}</span>
}

function Pill({ value }: { value: string }) {
  const cls =
    value === 'pass' ? 'pill pill-pass' : value === 'fail' ? 'pill pill-fail' : 'pill pill-skip'
  return <span className={cls}>{value}</span>
}

function ChannelColumn({
  title,
  hint,
  hits,
  unit,
}: {
  title: string
  hint: string
  hits: { chunkId: number; rank: number; score: number }[]
  unit: string
}) {
  return (
    <div className="channel">
      <div className="channel-head">
        <span>{title}</span>
        <em>{hint}</em>
      </div>
      {hits.length === 0 ? (
        <div className="muted pad">无命中</div>
      ) : (
        <ol className="rank-list">
          {hits.map((hit) => (
            <li key={`${title}-${hit.chunkId}`}>
              <span className="rank">{hit.rank}</span>
              <span className="chunk">#{hit.chunkId}</span>
              <span className="score">
                {hit.score.toFixed(4)} {unit}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function QueryCard({ audit, trace }: { audit: Audit; trace: ChannelTrace }) {
  const retrieval = audit.retrieval
  const principal = parseJson<Record<string, string>>(retrieval?.predicate_json, {})
  return (
    <section className="card query-card">
      <div className="card-kicker">查询 · 六元组</div>
      <h1>{retrieval?.query_norm ?? '—'}</h1>
      <div className="chips">
        <span className="chip">role <b>{principal.role ?? '—'}</b></span>
        <span className="chip">audience <b>{principal.audience ?? '—'}</b></span>
        <span className="chip">channel <b>{principal.channel ?? '—'}</b></span>
        <span className="chip">region <b>{principal.region ?? '—'}</b></span>
        <span className="chip">product <b>{principal.product_id ?? '—'}</b></span>
        <span className="chip">now <b>{(principal.now ?? '').slice(0, 10) || '—'}</b></span>
      </div>
      <div className="meta-line">
        <span>route <b>{retrieval?.route ?? trace.route ?? '—'}</b></span>
        <span>可见集 <b>{retrieval?.visible_count ?? 0}</b> chunks</span>
        <span>缓存 <b>{retrieval?.cache_hit ? 'HIT' : 'MISS'}</b></span>
        <span>session <b>{retrieval?.session_id ?? '—'}</b></span>
      </div>
      <div className="meta-line">
        <span>trace <code>{audit.traceId}</code></span>
        <span>time <b>{timeOf(retrieval?.created_at)}</b></span>
      </div>
    </section>
  )
}

function VerdictCard({ audit, verify }: { audit: Audit; verify: VerifyPayload | null }) {
  const answer = audit.answer
  const reason = answer?.reason_code ?? audit.retrieval?.reason_code ?? null
  return (
    <section className="card verdict-card">
      <div className="card-kicker">终态</div>
      <VerdictBadge verdict={answer?.verdict ?? audit.retrieval?.verdict ?? 'RED'} />
      {reason && (
        <div className="reason">
          <code>{reason}</code>
          <span>{REASON_LABEL[reason] ?? '—'}</span>
        </div>
      )}
      <div className="kv">
        <span>生成器</span>
        <b>{GENERATOR_LABEL[answer?.generator ?? 'none'] ?? answer?.generator}</b>
      </div>
      <div className="kv">
        <span>model</span>
        <b>{answer?.model ?? '—'}</b>
      </div>
      <div className="kv">
        <span>token</span>
        <b>
          {answer?.tokens_in ?? 0} in / {answer?.tokens_out ?? 0} out
        </b>
      </div>
      <div className="kv">
        <span>耗时</span>
        <b>{answer?.latency_ms ?? audit.retrieval?.latency_ms ?? 0} ms</b>
      </div>
      <div className="kv">
        <span>breaker</span>
        <b>{audit.retrieval?.breaker_state ?? 'CLOSED'}</b>
      </div>
      <div className="kv">
        <span>claims</span>
        <b>{verify?.claims.length ?? 0}</b>
      </div>
      <div className="kv">
        <span>引用</span>
        <b>{verify?.citations.length ?? 0}</b>
      </div>
    </section>
  )
}

function ChannelsCard({ trace }: { trace: ChannelTrace }) {
  const fused = trace.fused ?? []
  const lookupCells = trace.cells ?? []
  return (
    <section className="card channels-card">
      <div className="card-head">
        <div>
          <div className="card-kicker">检索通道 · RRF</div>
          <h2>双通道各自排名，融合后统一排序</h2>
        </div>
        <div className="terms">
          {(trace.terms ?? []).map((term) => (
            <span key={term} className="chip chip-term">
              {term}
            </span>
          ))}
        </div>
      </div>

      {trace.route === 'lookup' ? (
        <div className="lookup-block">
          <div className="muted">
            取数型问题走结构化通道：数值直接来自 cells，不经过 LLM。
          </div>
          <table>
            <thead>
              <tr>
                <th>cell</th>
                <th>字段</th>
                <th>数值（value_text）</th>
                <th>单位</th>
                <th>chunk</th>
              </tr>
            </thead>
            <tbody>
              {lookupCells.map((cell) => (
                <tr key={cell.cellId}>
                  <td className="mono">c-{cell.cellId}</td>
                  <td>{cell.label}</td>
                  <td className="mono strong">{cell.valueText}</td>
                  <td>{cell.unit || '—'}</td>
                  <td className="mono">#{cell.chunkId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="channel-grid">
          <ChannelColumn
            title="FTS5"
            hint={`k=${trace.rrfK ?? 60} · bm25`}
            hits={trace.fts5 ?? []}
            unit=""
          />
          <ChannelColumn
            title="VECTOR"
            hint="cosine distance"
            hits={trace.vector ?? []}
            unit=""
          />
          <div className="channel fused">
            <div className="channel-head">
              <span>RRF FUSED</span>
              <em>tier 先验加权</em>
            </div>
            {fused.length === 0 ? (
              <div className="muted pad">无融合结果</div>
            ) : (
              <ol className="rank-list">
                {fused.map((hit, index) => (
                  <li key={hit.chunkId}>
                    <span className="rank">{index + 1}</span>
                    <span className="chunk">#{hit.chunkId}</span>
                    <span className="tier">T{hit.tier}</span>
                    <span className="score">{hit.score.toFixed(5)}</span>
                    <span className="ranks">
                      F{hit.ranks.fts5 ?? '—'} · V{hit.ranks.vector ?? '—'}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
      {trace.vectorError && (
        <div className="warn">向量通道降级：{trace.vectorError}</div>
      )}
    </section>
  )
}

function EvidenceCard({
  item,
  marker,
  citations,
}: {
  item: EvidenceItem
  marker: string
  citations: Citation[]
}) {
  const spans = citations.filter((citation) => citation.marker === marker)
  return (
    <article className="evidence">
      <header>
        <span className="marker">{marker}</span>
        <span className={item.tier <= 1 ? 'tier tier-1' : 'tier'}>T{item.tier}</span>
        <span className="doc">{item.docId}</span>
        {item.clauseNo && <span className="clause">{item.clauseNo}</span>}
      </header>
      <div className="title">{item.title}</div>
      <p>
        <Highlight text={item.text} spans={spans} />
      </p>
      <footer>
        <span>chunk #{item.chunkId}</span>
        {spans.length > 0 && (
          <span>
            span {spans[0].charStart}–{spans[0].charEnd}
          </span>
        )}
      </footer>
    </article>
  )
}

function ClaimsCard({ verify }: { verify: VerifyPayload | null }) {
  return (
    <section className="card claims-card">
      <div className="card-kicker">逐 claim 校验</div>
      <h2>字面 → 蕴含 → 数值</h2>
      {!verify || verify.claims.length === 0 ? (
        <div className="muted pad">本轮没有生成 claim（拒答/消歧/取数模板）。</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>claim</th>
              <th>marker</th>
              <th>字面</th>
              <th>蕴含</th>
              <th>支持</th>
            </tr>
          </thead>
          <tbody>
            {verify.claims.map((claim) => (
              <tr key={claim.index}>
                <td className="mono">{claim.index + 1}</td>
                <td>{claim.text}</td>
                <td className="mono">{claim.markers.join(' ') || '—'}</td>
                <td><Pill value={claim.literal} /></td>
                <td><Pill value={claim.entailment} /></td>
                <td><Pill value={claim.support} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function NumbersCard({ verify }: { verify: VerifyPayload | null }) {
  return (
    <section className="card numbers-card">
      <div className="card-kicker">数值守恒对账</div>
      <h2>答案数值 ⊆ 引用 cell / 证据正文</h2>
      {!verify || verify.numbers.length === 0 ? (
        <div className="muted pad">本轮答案不含数值。</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>原文</th>
              <th>value_text</th>
              <th>单位</th>
              <th>来源</th>
              <th>对账</th>
            </tr>
          </thead>
          <tbody>
            {verify.numbers.map((number, index) => (
              <tr key={`${number.raw}-${index}`}>
                <td className="mono strong">{number.raw}</td>
                <td className="mono">{number.valueText}</td>
                <td>{number.unit || '—'}</td>
                <td className="mono">{number.source || '—'}</td>
                <td>
                  <span className={number.match ? 'pill pill-pass' : 'pill pill-fail'}>
                    {number.match ? 'match' : 'mismatch'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function BreakerCard({ audit }: { audit: Audit }) {
  const breaker = audit.breaker
  return (
    <section className="card breaker-card">
      <div className="card-kicker">熔断状态（持久化）</div>
      {breaker ? (
        <>
          <div className="kv"><span>连续 RED</span><b>{breaker.consecutive_red}</b></div>
          <div className="kv"><span>注入命中</span><b>{breaker.injection_hits}</b></div>
          <div className="kv"><span>锁定至</span><b>{epochTime(breaker.locked_until)}</b></div>
          <div className="kv"><span>最后原因</span><b>{breaker.last_reason ?? '—'}</b></div>
        </>
      ) : (
        <div className="muted pad">无状态（本会话尚未触发计数）。</div>
      )}
      {audit.breakerEvents.length > 0 && (
        <ul className="event-list">
          {audit.breakerEvents.map((event) => (
            <li key={event.log_id}>
              <span className="mono">{timeOf(event.created_at)}</span>
              <span className={event.event === 'LOCKED' ? 'event-lock' : 'event-ok'}>
                {event.event}
              </span>
              <span className="muted">{event.actor ?? '—'}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [recent, setRecent] = useState<RecentItem[]>([])
  const [audit, setAudit] = useState<Audit | null>(null)
  const [follow, setFollow] = useState(true)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const currentTrace = useRef<string | null>(null)

  useEffect(() => {
    fetchHealth()
      .then(setHealth)
      .catch((err: Error) => setError(err.message))
  }, [])

  const loadAudit = useCallback(async (traceId: string) => {
    setLoading(true)
    try {
      const next = await fetchAudit(traceId)
      currentTrace.current = traceId
      setAudit(next)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const items = await fetchRecent(20)
        if (cancelled) return
        setRecent(items)
        if (follow && items[0] && currentTrace.current !== items[0].trace_id) {
          const next = await fetchAudit(items[0].trace_id)
          if (cancelled) return
          currentTrace.current = items[0].trace_id
          setAudit(next)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      }
    }
    void tick()
    const timer = window.setInterval(tick, 2500)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [follow])

  const submit = async () => {
    const traceId = query.trim()
    if (!traceId) return
    setFollow(false)
    await loadAudit(traceId)
  }

  const selectRecent = async (item: RecentItem) => {
    setFollow(false)
    await loadAudit(item.trace_id)
  }

  const trace: ChannelTrace = parseJson<ChannelTrace>(audit?.retrieval?.channels_json, {})
  const verify: VerifyPayload | null = parseJson<VerifyPayload | null>(
    audit?.answer?.verify_json ?? null,
    null,
  )
  const citations = verify?.citations ?? []
  const verdict = audit?.answer?.verdict ?? audit?.retrieval?.verdict ?? 'RED'

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="logo">RAG</div>
          <div>
            <div className="brand-title">BAH 知识平面 · 证据面板</div>
            <div className="brand-sub">谓词 → 双通道 → RRF → 校验 → 终态</div>
          </div>
        </div>
        <div className="health">
          {health ? (
            <>
              <span className="chip">corpus <b>v{health.corpusVersion}</b></span>
              <span className="chip">docs <b>{health.docs}</b> · chunks <b>{health.chunks}</b></span>
              <span className={health.embedding === 'on' ? 'chip chip-on' : 'chip chip-off'}>
                embed <b>{health.embedding}</b>
              </span>
              <span className="chip mono" title={health.embedVersion}>
                {health.embedVersion.replace('fastembed:', '')}
              </span>
            </>
          ) : (
            <span className="chip">健康检查中…</span>
          )}
        </div>
        <div className="search">
          <input
            value={query}
            placeholder="输入 traceId 回溯"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit()
            }}
          />
          <button onClick={() => void submit()} disabled={loading}>
            {loading ? '读取中' : '回溯'}
          </button>
          <label className="follow">
            <input
              type="checkbox"
              checked={follow}
              onChange={(event) => setFollow(event.target.checked)}
            />
            跟随最新
          </label>
        </div>
      </header>

      {error && <div className="error">接口错误：{error}</div>}

      <div className="layout">
        <aside className="rail">
          <div className="rail-head">
            <span>最近查询</span>
            <em>{recent.length}</em>
          </div>
          <ul className="recent">
            {recent.map((item) => (
              <li
                key={item.trace_id}
                className={
                  (audit?.traceId === item.trace_id ? 'active ' : '') +
                  `dot-${item.verdict.toLowerCase()}`
                }
                onClick={() => void selectRecent(item)}
              >
                <div className="recent-line">
                  <span className="recent-time">{timeOf(item.created_at)}</span>
                  <span className="recent-verdict">{item.verdict.replace('AMBER_', 'A:')}</span>
                </div>
                <div className="recent-query">{item.query_norm}</div>
                <div className="recent-meta">
                  {item.route} · {item.latency_ms}ms · {item.generator ?? '—'}
                </div>
              </li>
            ))}
            {recent.length === 0 && <li className="muted pad">还没有查询记录。</li>}
          </ul>
          {audit && <BreakerCard audit={audit} />}
        </aside>

        <main className="content">
          {!audit ? (
            <section className="card empty">
              <div className="card-kicker">等待数据</div>
              <h2>先向 /v1/answer 发一次查询</h2>
              <pre>{`curl -s http://127.0.0.1:7801/v1/answer \\
  -H 'Content-Type: application/json' \\
  -d '{"schemaVersion":"knowledge.v1","sessionId":"demo",
       "query":"稳盈90天持有不满7天赎回费率是多少？",
       "principal":{"role":"retail","audience":"standard",
       "channel":"headless","region":"CN-SH",
       "now":"2026-10-19T12:00:00+08:00"}}'`}</pre>
              <p className="muted">面板每 2.5 秒跟随最新 trace，也可以输入 traceId 回溯。</p>
            </section>
          ) : (
            <>
              <div className="row top">
                <QueryCard audit={audit} trace={trace} />
                <VerdictCard audit={audit} verify={verify} />
              </div>

              <ChannelsCard trace={trace} />

              <section className="card evidence-card">
                <div className="card-head">
                  <div>
                    <div className="card-kicker">证据 · span 高亮</div>
                    <h2>引用必须能解析到 charRange</h2>
                  </div>
                  <div className="muted">{audit.evidence.length} 条</div>
                </div>
                {audit.evidence.length === 0 ? (
                  <div className="muted pad">本轮无证据（拒答/消歧）。</div>
                ) : (
                  <div className="evidence-grid">
                    {audit.evidence.map((item, index) => (
                      <EvidenceCard
                        key={item.chunkId}
                        item={item}
                        marker={`K${index + 1}`}
                        citations={citations}
                      />
                    ))}
                  </div>
                )}
              </section>

              {audit.answer?.answer_text && (
                <section className="card answer-card">
                  <div className="card-kicker">返回给用户的文本</div>
                  <p>{audit.answer.answer_text}</p>
                </section>
              )}

              <div className="row">
                <ClaimsCard verify={verify} />
                <NumbersCard verify={verify} />
              </div>
            </>
          )}
        </main>
      </div>
      <footer className="foot">
        verdict <b>{verdict}</b> · trace <code>{audit?.traceId ?? '—'}</code> · 数据源：/v1/audit
      </footer>
    </div>
  )
}
