/**
 * bundle `base`（施工单 06 §3）：底座首层。
 *
 * 内容 = 内核之上的一切"每个入口都要"的插件行：会话、工具、提示词、模型、主循环、持久化。
 * 它**不写死任何渠道**：语气、模型、是否带 UI 全部由各 profile 的 patch 表达。
 *
 * 为什么这里只有数据没有代码：行引用 `use`（依赖清单里的插件实现），
 * 想换实现只需要换依赖清单或加一行 patch——bundle 文件因此永远不需要 import 运行时。
 */

import type { Bundle } from '@bah/host'

/** base bundle：所有 profile 的第一层。 */
export const bundle: Bundle = {
  name: 'base',
  rows: [
    { id: 'core:session' },
    { id: 'core:tools' },
    { id: 'core:prompt' },
    // 生产默认：真实 provider。headless 的 patch 会把它整块换成 mock（层序演示见 docs/profile.md）
    { id: 'core:model', config: { provider: 'deepseek', model: 'deepseek-chat' } },
    { id: 'core:agent', config: { loop: { model: 'deepseek:deepseek-chat' } } },
    { id: 'core:persistence', config: { root: 'sessions' } },
  ],
}
