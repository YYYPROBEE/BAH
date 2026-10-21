# NOTICE

本仓库（BAH, Banking Agent Harness）为独立实现。本工程未包含、未衍生自任何第三方
Harness 项目（包括 DeepSeek Harness / dsh）的源代码；架构与机制层面参考了其公开
文档中描述的设计思想，全部实现由本项目作者完成。

本工程复用了作者自有工程 `sentry-dsh-plugin` 与 `caai-sentry` 的安全内核
（归一化 / 注入签名检测 / 危险规则 / 预算 / 断路器 / 审计），为原创代码。

前端视觉体系 `design/bah-ds/`（BAH DS）为本工程自研设计系统：令牌定义、组件契约与
图标资产均由本项目维护，`apps/web/styles/ds/` 是其逐字节分发副本，由 `verify-web` 门禁校验。

若后续引入第三方 MIT/Apache 组件，在此逐项标注：
（暂无）
