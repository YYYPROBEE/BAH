import { el, icon } from '../dom.js'
import { renderAudit, renderAuditCounts } from '../views/audit.js'

/**
 * 过程记录模块（移动端）。
 *
 * 审计帧数量远大于对话消息，逐条铺在会话流里会把正文挤走。这里把它们收成一张卡：
 * 收起时只给分类次数（安全防护 / 工具调用 / 审批 / 票据 / 轮次…），点「展开」才铺明细。
 * 展开状态跨帧更新保留（sync 每次都重建明细，但不重置用户的展开选择）。
 *
 * @param {HTMLElement} host 会话流里的独立模块槽位
 */
export function createAuditGroup(host) {
  let expanded = false
  let frames = []

  const title = el('span', { class: 'audit-group__title', text: '过程记录' })
  let counts = renderAuditCounts([])
  const toggle = el('button', {
    class: 'ds-btn ds-btn--ghost ds-btn--sm audit-group__toggle',
    type: 'button',
    'aria-expanded': 'false',
    dataset: { role: 'audit-toggle' },
    text: '展开',
  })
  const list = el('ol', { class: 'audit-group__list', 'aria-label': '过程记录明细', hidden: true })
  const node = el('section', { class: 'audit-group', dataset: { role: 'audit-group', state: 'collapsed' } }, [
    el('div', { class: 'audit-group__head' }, [icon('doc', 14), title, toggle]),
    counts,
    list,
  ])
  host.append(node)
  node.hidden = true

  toggle.addEventListener('click', () => {
    expanded = !expanded
    render()
    // 模块在会话流末尾：展开后把模块顶到视口顶，否则新增的明细全在停靠栏下面。
    if (expanded) node.scrollIntoView?.({ block: 'start' })
    else node.scrollIntoView?.({ block: 'nearest' })
  })

  function render() {
    node.hidden = frames.length === 0
    if (frames.length === 0) return

    node.dataset.state = expanded ? 'expanded' : 'collapsed'
    toggle.setAttribute('aria-expanded', String(expanded))
    toggle.textContent = expanded ? '收起' : '展开'

    const nextCounts = renderAuditCounts(frames)
    counts.replaceWith(nextCounts)
    counts = nextCounts

    if (expanded) {
      list.replaceChildren(...frames.map((frame) => renderAudit(frame)))
      list.hidden = false
    } else {
      list.replaceChildren()
      list.hidden = true
    }
  }

  return {
    node,
    update(next) {
      frames = next
      render()
    },
    get expanded() {
      return expanded
    },
    dispose() {
      node.remove()
    },
  }
}
