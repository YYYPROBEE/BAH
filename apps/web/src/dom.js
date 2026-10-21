/**
 * 极简 DOM 构造器（纯原生，无框架）。
 *
 * 为什么坚持 `textContent` 而不是 `innerHTML`：所有文本都来自模型与会话日志，
 * 属于不可信输入；用 `innerHTML` 拼一句话，XSS 就只需要模型"说错一次"。
 * 本文件不提供任何 HTML 字符串入口——想插富文本，只能继续用 `el()` 组合。
 */

/**
 * 造节点。
 *
 * @param {string} tag 标签名
 * @param {Record<string, unknown>} [attrs] 属性（`class` / `text` / `dataset` / `on*`）
 * @param {Array<Node|string|null|undefined>} [children] 子节点
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag)

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = String(value)
    else if (key === 'text') node.textContent = String(value)
    else if (key === 'dataset') Object.assign(node.dataset, value)
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value)
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value)
    } else node.setAttribute(key, value === true ? '' : String(value))
  }

  append(node, children)
  return node
}

/** 追加子节点（字符串一律转文本节点）。 */
export function append(node, children) {
  for (const child of children) {
    if (child === undefined || child === null || child === false) continue
    if (Array.isArray(child)) append(node, child)
    else if (typeof child === 'string') node.append(document.createTextNode(child))
    else node.append(child)
  }
}

/** 清空子节点。 */
export function clear(node) {
  while (node.firstChild !== null) node.removeChild(node.firstChild)
}

/**
 * 图标（本地 SVG + CSS mask，颜色跟随 `currentColor`）。
 *
 * 规格来自自研 BAH DS 图标规范：默认 16×16、密集控件 14×14、大图标 24×24；
 * 纯装饰图标带 `aria-hidden`，语义由相邻文本承担。
 *
 * @param {'send'|'stop'|'close'|'check'|'error'|'clock'|'branch'|'ai'|'agent'|'doc'|'refresh'|'user'|'search'|'up'} name
 * @param {14|16|24} [size]
 */
export function icon(name, size = 16) {
  return el('span', {
    class: `icon icon--${name}`,
    style: { '--icon-size': `${size}px` },
    'aria-hidden': 'true',
  })
}

/** 文本（数字/金额统一走这里，便于以后加 `tabular-nums` 之类的处理）。 */
export function span(className, text) {
  return el('span', { class: className, text })
}
