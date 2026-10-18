/**
 * Web 渠道入口（M0 骨架，阶段 1）。
 *
 * 技术约束（决策 D3）：纯原生 HTML5 + CSS3 + JavaScript（ES6+），不引入 Vue/React
 * 或任何 UI 组件库；Vite 仅作 dev server / 打包器。
 *
 * 本文件只做"页面能挂上"的最小验证，不实现任何运行逻辑；
 * 会话跟随流、审批弹窗、卡片渲染见施工单 13。
 */

const root = document.querySelector('#app')

if (root instanceof HTMLElement) {
  root.textContent = 'BAH 底座骨架（阶段 1）· Web 渠道待施工单 13 实装'
}

export {}
