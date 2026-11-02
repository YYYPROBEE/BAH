/**
 * 历史对话列表与只读回放（2026-11-02）。
 *
 * 纯渲染件：不 fetch、不解析会话事件、不改任何状态。数据由装配根（`main.js` /
 * `mobile/shell.js`）注入，两份壳共用本文件——否则"桌面看到 42 条、手机上看到 41 条"
 * 这类分叉迟早出现。
 *
 * ## 为什么不能直接 `frames.map(renderFrame)`
 *
 * `renderFrame`（`conversation.js:51`）只认识 8 类对话帧，其余一律渲染成"未知帧"。
 * 而一条真实会话里还有审批、调用图、审计、交接、目标、待办六类，正常页面各有专门去处
 * （弹窗 / 右栏 / tab / 横幅）。历史里没有那些容器，只能降级成一行记录。
 *
 * ## 为什么审批卡必须"不渲染"而不是置灰
 *
 * 审批卡上的按钮会 `POST /api/approval/<ticketId>`。历史视图读的是**别的**会话的票据，
 * 而 HTTP 渠道服务的始终是**当前**会话——真点下去要么 `403 foreign-ticket`，
 * 要么（同号票据时）跨会话误批。所以这里连按钮都不生成，只留一行"曾请求审批"。
 */

import { el, icon } from '../dom.js'

/** 能安全复用对话流渲染件的帧：纯展示，没有写操作入口。 */
const RENDERABLE = new Set(['turn', 'message', 'notice', 'tool', 'effects', 'plan-card'])

/** 交互类与容器类帧在历史里的固定文案。 */
const RECORD_LABEL = {
  choice: '曾提出选择题（历史只读，不可作答）',
  'risk-questionnaire': '曾发起风险测评（历史只读，不可作答）',
  audit: '审计记录',
}

/** 时间戳 → `MM-DD HH:mm`（本地时区；历史列表不显示年份，跨年会话靠标题辨认）。 */
export function historyStamp(at) {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return '—'
  const date = new Date(at)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 一条历史摘要 → 列表行。 */
function historyRow(item, onOpen) {
  const meta = `${historyStamp(item.lastAt)} · ${String(item.events)} 条 · ${String(item.turns)} 轮`
  const button = el(
    'button',
    {
      class: 'history__item',
      type: 'button',
      dataset: { role: 'history-item', session: String(item.sessionId) },
      onclick: () => onOpen(item.sessionId),
    },
    [
      el('span', { class: 'history__title', text: String(item.title) }),
      el('span', { class: 'history__meta', text: meta }),
    ],
  )
  return el('li', { class: 'history__row' }, [
    button,
    ...(item.current === true
      ? [el('span', { class: 'history__badge', text: '当前' })]
      : []),
  ])
}

/** 列表（有数据时）。 */
export function renderHistoryList(items, onOpen) {
  return el(
    'ol',
    { class: 'history__list', 'aria-label': '历史会话' },
    items.map((item) => historyRow(item, onOpen)),
  )
}

/** 空态：区分"还没聊过"与"读不出来"，两者的下一步动作不同。 */
export function renderHistoryEmpty(text = '还没有历史会话。') {
  return el('div', { class: 'history__empty', dataset: { role: 'history-empty' } }, [
    icon('clock', 20),
    el('span', { text }),
  ])
}

/** 加载中。 */
export function renderHistoryLoading() {
  return el('div', { class: 'history__empty', dataset: { role: 'history-loading' }, text: '正在读取…' })
}

/** 失败态：把服务端给的理由原样带出来，不吞成"加载失败"。 */
export function renderHistoryError(reason) {
  return el('div', { class: 'history__empty history__empty--error', dataset: { role: 'history-error' } }, [
    icon('error', 20),
    el('span', { text: typeof reason === 'string' && reason !== '' ? reason : '读取历史失败' }),
  ])
}

/**
 * 只读回放横幅。
 *
 * 文案必须说清"看得到、接不上"：这个版本没有会话切换（多会话宿主 D4 未实现），
 * 写了"继续此对话"就是假入口。
 */
export function renderHistoryBanner(options) {
  const title = typeof options?.title === 'string' && options.title !== '' ? options.title : '历史会话'
  return el('div', { class: 'history-banner', role: 'status', dataset: { role: 'history-banner' } }, [
    icon('clock', 14),
    el('span', { class: 'history-banner__text', text: `只读历史：${title}` }),
    el('span', { class: 'history-banner__hint', text: '可查看，不能在当前进程里接着聊' }),
    el(
      'button',
      {
        class: 'ds-btn ds-btn--ghost ds-btn--sm',
        type: 'button',
        dataset: { role: 'history-back' },
        onclick: () => options?.onBack?.(),
      },
      ['返回当前会话'],
    ),
  ])
}

/** 非对话帧 → 一行记录。 */
function recordText(frame) {
  switch (frame.kind) {
    case 'approval': {
      const operation =
        typeof frame.operation === 'string' && frame.operation !== ''
          ? frame.operation
          : typeof frame.name === 'string'
            ? frame.name
            : '操作'
      const amount = typeof frame.amountText === 'string' ? ` · ${frame.amountText}` : ''
      return `请求审批：${operation}${amount}`
    }
    case 'approval-closed': {
      const label =
        typeof frame.label === 'string' && frame.label !== ''
          ? frame.label
          : typeof frame.decision === 'string'
            ? frame.decision
            : '已处理'
      return `审批结论：${label}`
    }
    case 'dag': {
      const count = Array.isArray(frame.nodes) ? frame.nodes.length : 0
      return `调用图（${String(count)} 个节点）`
    }
    case 'goal':
      return `目标：${typeof frame.title === 'string' ? frame.title : '未命名'}`
    case 'todo': {
      const open = typeof frame.openCount === 'number' ? frame.openCount : 0
      return `执行清单（${String(open)} 项未完成）`
    }
    case 'handoff':
      return frame.active === true ? '转人工：已接入坐席' : '转人工：已交回'
    case 'handoff-warn':
      return '接管超时告警'
    default:
      return RECORD_LABEL[frame.kind] ?? `记录（${String(frame.kind)}）`
  }
}

/** 一行只读记录（审批 / 调用图 / 审计 / 交接 / 目标 / 待办）。 */
export function renderRecordRow(frame) {
  return el(
    'div',
    {
      class: 'history-record',
      dataset: { role: 'history-record', kind: String(frame.kind) },
    },
    [icon('doc', 12), el('span', { class: 'history-record__text', text: recordText(frame) })],
  )
}

/**
 * 把一份 `snapshot.frames` 渲染成只读节点列表。
 *
 * @param {readonly {kind: string}[]} frames
 * @param {(frame: unknown) => HTMLElement} [renderFrame] 注入对话流渲染件（默认为空实现，
 *   让本文件在没有 view 依赖时也能单独测）
 */
export function renderReadonlyFrames(frames, renderFrame) {
  const nodes = []
  for (const frame of frames ?? []) {
    if (frame === null || typeof frame !== 'object') continue
    // snapshot 是容器帧本身，delta 是流式残片（历史里没有"正在打字"这回事）
    if (frame.kind === 'snapshot' || frame.kind === 'delta') continue
    if (RENDERABLE.has(frame.kind) && typeof renderFrame === 'function') {
      nodes.push(renderFrame(frame))
      continue
    }
    nodes.push(renderRecordRow(frame))
  }
  return nodes
}

/**
 * 历史抽屉的完整内容（**不含标题栏与关闭按钮**：外壳由 `createDialog` 提供，
 * 那里已经有焦点陷阱与 Esc 关闭，再画一个头就是两个关闭入口）。
 *
 * @param {{items?: readonly unknown[], loading?: boolean, error?: string|null, onOpen: (id: string) => void, onRefresh?: () => void}} options
 */
export function renderHistoryPanel(options) {
  const body =
    options.error !== null && options.error !== undefined
      ? renderHistoryError(options.error)
      : options.loading === true
        ? renderHistoryLoading()
        : (options.items ?? []).length === 0
          ? renderHistoryEmpty()
          : renderHistoryList(options.items ?? [], options.onOpen)

  return el('div', { class: 'history', dataset: { role: 'history-panel' } }, [
    el('div', { class: 'history__body' }, [body]),
    el('footer', { class: 'history__foot' }, [
      el('span', {
        class: 'history__note',
        text: '历史只读：可查看过去的对话记录；要继续请回到当前会话输入。',
      }),
      ...(typeof options.onRefresh === 'function'
        ? [
            el(
              'button',
              {
                class: 'ds-btn ds-btn--ghost ds-btn--sm',
                type: 'button',
                dataset: { role: 'history-refresh' },
                onclick: () => options.onRefresh(),
              },
              ['刷新'],
            ),
          ]
        : []),
    ]),
  ])
}

/**
 * 只读回放视图：横幅 + 帧流。
 *
 * `renderFrame` 由装配根注入（`main.js` / `mobile/shell.js` 各一份视图栈），
 * 本文件不 import `conversation.js`——那样移动端会连桌面壳的对话流一起拉进来。
 *
 * @param {{title?: string, frames?: readonly unknown[], renderFrame?: (frame: unknown) => HTMLElement, onBack?: () => void}} options
 */
export function renderReadonlyView(options) {
  return el('div', { class: 'history-readonly', dataset: { role: 'history-readonly' } }, [
    el('div', { class: 'history-readonly__banner' }, [
      renderHistoryBanner({ title: options.title, onBack: options.onBack }),
    ]),
    el(
      'div',
      { class: 'history-readonly__feed', dataset: { role: 'history-feed' } },
      renderReadonlyFrames(options.frames ?? [], options.renderFrame),
    ),
  ])
}
