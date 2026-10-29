/**
 * 对话流（施工单 13 §2.1 第一行 + §5.1）。
 *
 * 只有四种节点：轮次分割、消息气泡、行内提示、工具卡（工具卡在 `tool-card.js`）。
 * 全部从帧生成，没有"输入框回显"这类平行状态——POST 成功不插入气泡，
 * 用户消息一律等 `user/message` 帧（避免双份，`docs/web-frontend.md` §7 末条）。
 */

import { el, icon } from '../dom.js'
import { renderTool } from './tool-card.js'

/** 对话流收纳的帧类型。 */
export const CONVERSATION_KINDS = new Set(['turn', 'message', 'notice', 'tool'])

/** 轮次结束原因的文案（`guard-stopped` 与 `failed` 必须区分）。 */
const END_LABEL = {
  completed: '完成',
  blocked: '被拦截',
  aborted: '已中断',
  'max-tokens': '达到输出上限',
  'guard-stopped': '已判停',
  failed: '失败',
}

/**
 * 一条帧 → 节点。
 *
 * @param {Record<string, any>} frame
 * @returns {HTMLElement}
 */
export function renderFrame(frame) {
  switch (frame.kind) {
    case 'turn':
      return renderTurn(frame)
    case 'message':
      return renderMessage(frame)
    case 'notice':
      return renderNotice(frame)
    case 'tool':
      return renderTool(frame)
    default:
      return el('div', { class: 'frame-unknown', text: `未知帧：${String(frame.kind)}` })
  }
}

/** 轮次分割线。 */
export function renderTurn(frame) {
  const label = frame.turn === 0 ? '准备' : `第 ${String(frame.turn)} 轮`
  // 缺 `endKind` 的收尾帧不能渲染成"第 2 轮 · undefined"：服务端没说原因就写"已结束"。
  const end = frame.phase === 'end' ? (END_LABEL[frame.endKind] ?? frame.endKind ?? '已结束') : '进行中'
  return el('div', { class: 'turn-divider', dataset: { turn: String(frame.turn) } }, [
    el('span', { class: 'turn-divider__line' }),
    el('span', { class: 'turn-divider__label', text: `${label} · ${end}` }),
    el('span', { class: 'turn-divider__line' }),
  ])
}

/** 消息气泡。 */
export function renderMessage(frame) {
  const role = frame.role === 'operator' ? 'operator' : frame.role === 'user' ? 'user' : 'assistant'
  // 接管期客户留言（`handoff-waiting`）是**真人说的话**：必须画成 user 气泡并标注
  // "等待坐席处理"，不能混进下面的上下文样式，否则客户会以为"消息石沉大海"。
  const handoffWaiting = role === 'user' && frame.source === 'handoff-waiting'
  // 模型的上下文类消息（`context` = 工具后置纠正，`runtime-context` = 每次请求现渲染的用户档案）
  // 都不是用户发言；`handoff-handover` 是人工交回时系统写的交接语，也不是用户原话。
  // 三者都用提示样式，避免"用户说了没说过的话"。
  const contextSource =
    role === 'user' && !handoffWaiting && typeof frame.source === 'string' && frame.source !== 'user'
      ? frame.source
      : null
  const contextLabel =
    contextSource === 'context'
      ? '系统纠正（模型可见）'
      : contextSource === 'handoff-handover'
        ? '系统交接（已交回智能助手）'
        : '运行时上下文（模型可见）'

  const body = el(
    'div',
    { class: 'bubble__body' },
    (frame.blocks ?? []).map((block) => renderBlock(block)),
  )

  if (contextSource !== null) {
    // 运行时上下文每轮一张、内容是一整份用户档案（姓名/等级/余额/流水），实测 292px 高，
    // 比用户气泡和工具卡都大，会把真正的对话挤出屏幕。默认折叠成一行，需要时再展开。
    // 其余两类（系统纠正 / 交接语）本来就短，保持直接可见。
    const collapsible = contextSource === 'runtime-context'
    const toggle = collapsible
      ? el(
          'button',
          {
            class: 'ds-btn ds-btn--ghost ds-btn--sm message__toggle',
            type: 'button',
            'aria-expanded': 'false',
            onclick: () => {
              const open = body.hidden
              body.hidden = !open
              toggle.setAttribute('aria-expanded', open ? 'true' : 'false')
              toggle.textContent = open ? '收起' : '展开'
            },
          },
          ['展开'],
        )
      : null
    if (collapsible) body.hidden = true
    return el('div', { class: 'message message--correction', dataset: { seq: String(frame.seq), source: contextSource } }, [
      el('div', { class: 'message__meta' }, [icon('ai', 14), contextLabel, ...(toggle === null ? [] : [toggle])]),
      body,
    ])
  }

  // 只有工具调用的助手消息没有正文：不留一个空气泡，用一行说明代替。
  // 文案说"发起"而不是"调用中"：这条消息落账后不会随工具结果更新，
  // 写"调用中…"会让一条早已完成的调用永远显示成进行中（工具状态只在卡片里更新）。
  const hasText = (frame.blocks ?? []).some(
    (block) => block.type !== 'text' || (typeof block.text === 'string' && block.text.trim().length > 0),
  )
  if (role === 'assistant' && !hasText) {
    return el('div', { class: 'message message--assistant message--tool-only', dataset: { seq: String(frame.seq) } }, [
      el('div', { class: 'message__meta' }, [icon('agent', 14), 'BAH', el('span', { class: 'message__seq', text: '发起工具调用' })]),
    ])
  }

  const label = role === 'operator' ? (frame.operator ?? '人工坐席') : role === 'user' ? '你' : 'BAH'
  // 图标：坐席与客户共用 `UserCheck.svg`（没有"耳机/坐席"图标），
  // 区分靠 `.message--operator` 的品牌底色 + meta 文案，不靠图标。
  const iconName = role === 'assistant' ? 'agent' : 'user'

  return el(
    'article',
    {
      class: `message message--${role}${handoffWaiting ? ' message--handoff-waiting' : ''}`,
      dataset: { seq: String(frame.seq), role },
    },
    [
      el('div', { class: 'message__meta' }, [
        icon(iconName, 14),
        label,
        el('span', { class: 'message__seq', text: `#${String(frame.seq)}` }),
        ...(handoffWaiting
          ? [el('span', { class: 'ds-tag ds-tag--warning', text: '等待坐席处理' })]
          : []),
      ]),
      body,
      ...(frame.toolCalls === undefined || frame.toolCalls.length === 0
        ? []
        : [
            el(
              'div',
              { class: 'message__calls' },
              frame.toolCalls.map((call) =>
                el('span', { class: 'ds-tag', text: `${call.name} · ${call.callId}` }),
              ),
            ),
          ]),
    ],
  )
}

/** 一个内容块。 */
export function renderBlock(block) {
  if (block.type === 'text') return el('p', { class: 'bubble__text', text: block.text })
  if (block.type === 'image') {
    return el('img', {
      class: 'bubble__image',
      src: `data:${block.mimeType};base64,${block.data}`,
      alt: '会话图片',
      loading: 'lazy',
    })
  }
  return el('p', { class: 'bubble__text bubble__text--muted', text: `[${String(block.summary)}]` })
}

/** 行内提示。 */
export function renderNotice(frame) {
  const variant =
    frame.level === 'danger'
      ? 'ds-alert--danger'
      : frame.level === 'warning'
        ? 'ds-alert--warning'
        : frame.level === 'success'
          ? 'ds-alert--success'
          : 'ds-alert--info'
  return el('div', { class: `ds-alert ${variant} notice`, dataset: { seq: String(frame.seq) } }, [
    el('span', { class: 'ds-alert__icon' }, [icon(frame.level === 'danger' ? 'error' : 'ai', 16)]),
    el('div', { class: 'notice__body' }, [
      el('div', { class: 'ds-alert__title' }, [
        frame.title,
        ...(frame.code === undefined ? [] : [' ', el('code', { class: 'ds-code', text: frame.code })]),
      ]),
      ...(frame.text === undefined ? [] : [el('p', { class: 'ds-alert__desc', text: frame.text })]),
    ]),
  ])
}

/** 流式草稿（`delta` 累积；权威消息到达即被替换）。 */
export function renderDraft(text) {
  return el('article', { class: 'message message--assistant message--draft', dataset: { draft: 'true' } }, [
    el('div', { class: 'message__meta' }, [icon('agent', 14), 'BAH', el('span', { class: 'message__seq', text: '生成中…' })]),
    el('div', { class: 'bubble__body' }, [el('p', { class: 'bubble__text', text })]),
  ])
}

/** 空态（三幕演示提示）。 */
export function renderEmptyState() {
  return el('div', { class: 'ds-empty conversation__empty' }, [
    el('div', { class: 'ds-empty__icon' }, [icon('ai', 24)]),
    el('p', { class: 'ds-empty__title', text: '还没有对话' }),
    el('p', {
      class: 'ds-empty__desc',
      text: '试试「给王建国转 800 元」——会触发黄色审批；或问「稳盈90天起购金额是多少」看知识卡。',
    }),
  ])
}
