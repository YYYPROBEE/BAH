# NOTICE

本仓库（BAH, Banking Agent Harness）为独立实现。本工程未包含、未衍生自任何第三方
Harness 项目（包括 DeepSeek Harness / dsh）的源代码；架构与机制层面参考了其公开
文档中描述的设计思想，全部实现由本项目作者完成。

本工程复用了作者自有工程 `sentry-dsh-plugin` 与 `caai-sentry` 的安全内核
（归一化 / 注入签名检测 / 危险规则 / 预算 / 断路器 / 审计），为原创代码。
其中工具名通配匹配（原 `wildcardToRegExp`）曾与 dsh 的同名实现存在语义特异重合，
已于 2026-10-22 改写为 `compileToolGlob`（按 `*` 切段 → 逐段转义 → `.*` 连接）
并同步更名，主仓与 `sentry-dsh-plugin` 两侧均已替换；比对结果见
`审计-2026-10-21/probe-line-overlap.cjs` 的输出（语义特异重合 0 处）。

前端视觉体系 `design/bah-ds/`（BAH DS）为本工程自研设计系统：令牌定义、组件契约与
图标资产均由本项目维护，`apps/web/styles/ds/` 是其逐字节分发副本，由 `verify-web` 门禁校验。

若后续引入第三方 MIT/Apache 组件，在此逐项标注：
（暂无）
