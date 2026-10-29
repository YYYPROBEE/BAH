/**
 * 观测面板的轮询控制器（可观测性 03 §4.3）。
 *
 * 五条纪律：
 * 1. `setTimeout` 链，同一时刻最多 1 个在途请求；
 * 2. 失败退避 `[2000,2000,4000,8000,16000,30000]`，成功即复位；
 * 3. `document.hidden` 时停表，可见且仍激活时恢复；
 * 4. `metrics()` 与 `trace()` 并行（`Promise.allSettled`），一个失败不清空另一个；
 * 5. `staleSec` 只在连续失败 ≥3 后出现，用注入的 `now()` 计算。
 *
 * **不用 SSE 推**：指标是随时可重算的派生量，推它等于把派生量变成状态（U-1）。
 */

/** 失败退避表（毫秒）；索引取 `min(failures, 5)`。 */
const BACKOFF = [2000, 2000, 4000, 8000, 16000, 30000]

/** 手动刷新节流（毫秒）。 */
const MANUAL_THROTTLE_MS = 1000

/** 连续失败多少轮后开始报「数据陈旧」。 */
const STALE_AFTER = 3

/**
 * @param {{
 *   api: { metrics: () => Promise<any>, trace: (q?: object) => Promise<any> },
 *   onState: (state: object) => void,
 *   intervalMs?: number,
 *   timeoutMs?: number,
 *   now?: () => number,
 * }} options
 */
export function createObservability(options) {
  const api = options.api
  const onState = options.onState
  const intervalMs = options.intervalMs ?? 2000
  const timeoutMs = options.timeoutMs ?? 3000
  const now = options.now ?? (() => Date.now())
  const createdAt = now()

  /** 当前快照（对外只给副本）。 */
  let snapshot = { metrics: null, trace: null, status: 'connecting', staleSec: null, error: null }
  let timer = null
  let inFlight = false
  let engage = false
  let disposed = false
  let failures = 0
  let lastOkAt = null
  let lastManualAt = -Infinity

  /** 清定时器（不动 `engage`）。 */
  function clearTimer() {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  /** 排下一次（只有仍激活且没有在途时才排）。 */
  function schedule(delayMs) {
    if (disposed || !engage || timer !== null) return
    timer = setTimeout(() => {
      timer = null
      void poll()
    }, delayMs)
  }

  /** 给请求加超时（不依赖 AbortSignal：jsdom 不保证它有 `timeout`）。 */
  function withTimeout(promise) {
    let handle = null
    const timeout = new Promise((_, reject) => {
      handle = setTimeout(() => reject(new Error('obs-timeout')), timeoutMs)
    })
    return Promise.race([promise, timeout]).finally(() => {
      if (handle !== null) clearTimeout(handle)
    })
  }

  /** 把一次调用归一成 `{ ok, data }` 或 `{ ok:false, code }`（不抛）。 */
  async function attempt(call) {
    try {
      const result = await withTimeout(Promise.resolve().then(call))
      if (result !== null && typeof result === 'object' && result.ok === false) {
        return { ok: false, code: result.code ?? 'http-error' }
      }
      return { ok: true, data: result?.data ?? null }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, code: message === 'obs-timeout' ? 'timeout' : 'network-error' }
    }
  }

  /** 吸收一轮结果：成功的覆盖、失败保留旧值。 */
  function absorb(metrics, trace) {
    const next = { ...snapshot }
    let ok = false
    let failure = null

    if (metrics.ok) {
      next.metrics = metrics.data
      ok = true
    } else {
      failure = { code: metrics.code, reason: '指标读取失败' }
    }

    if (trace.ok) {
      next.trace = trace.data
      ok = true
    } else if (failure === null) {
      failure = { code: trace.code, reason: '轨迹读取失败' }
    }

    if (ok) {
      failures = 0
      lastOkAt = now()
    } else {
      failures += 1
    }

    next.status = ok ? 'online' : 'offline'
    next.error = failure
    next.staleSec =
      failures >= STALE_AFTER
        ? Math.max(0, Math.round((now() - (lastOkAt ?? createdAt)) / 1000))
        : null
    snapshot = next
    onState({ ...next })
    return ok
  }

  /** 跑一轮。 */
  async function poll() {
    if (disposed || !engage || inFlight) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      clearTimer()
      return
    }
    inFlight = true
    const [metrics, trace] = await Promise.allSettled([
      attempt(() => api.metrics()),
      attempt(() => api.trace()),
    ])
    inFlight = false
    if (disposed) return

    const ok = absorb(
      metrics.status === 'fulfilled' ? metrics.value : { ok: false, code: 'network-error' },
      trace.status === 'fulfilled' ? trace.value : { ok: false, code: 'network-error' },
    )
    schedule(ok ? intervalMs : BACKOFF[Math.min(failures - 1, BACKOFF.length - 1)])
  }

  /** 可见性变化：隐藏停表，恢复且仍激活时重启。 */
  function onVisibility() {
    if (typeof document === 'undefined') return
    if (document.visibilityState === 'hidden') clearTimer()
    else if (engage) start()
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)

  /** 启动（幂等：在途或已排表都不重复发）。 */
  function start() {
    if (disposed) return
    engage = true
    if (timer !== null || inFlight) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    void poll()
  }

  /** 停止（幂等；在途请求回来后不会再排下一轮）。 */
  function stop() {
    engage = false
    clearTimer()
  }

  /** 手动刷新（≥1s 一次；不在观测 tab 时也能用，故顺手激活）。 */
  function refreshOnce() {
    if (disposed) return
    const at = now()
    if (at - lastManualAt < MANUAL_THROTTLE_MS) return
    lastManualAt = at
    engage = true
    if (inFlight) return
    clearTimer()
    void poll()
  }

  return {
    setActive(active) {
      if (active) start()
      else stop()
    },
    start,
    stop,
    refreshOnce,
    state() {
      return { ...snapshot }
    },
    /** 测试/卸载用：摘可见性监听并停表（不属于对外契约）。 */
    dispose() {
      disposed = true
      engage = false
      clearTimer()
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
    },
  }
}
