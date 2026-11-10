# 更新日志

本项目遵循语义化版本；日期为发布日。条目按「许可 / 新增 / 变更 / 修复」组织，
只记录对外可观察的行为差异，不记录内部施工过程。

## v1.0.0 — 2026-11-10

首个开源版本。此前代码在比赛提交线（tag `v1.0-submit`）上迭代；本版把许可、文档与 CI
调整到可对外协作的状态，功能面与提交线一致。

### 许可

- 全仓改为 **Apache-2.0**（原为 source-available 自定义许可），允许商业使用、修改与再分发。
- 22 个 `package.json` 补齐 `license` 字段；`NOTICE.md` 按 Apache-2.0 §4(d) 补来源与归属声明，
  并保留第三方组件（Electron / Chromium）与九项机制借鉴的登记表。

### 新增（社区协作面）

- `CONTRIBUTING.md`：环境、`pnpm check` 链路、按改动类型该同步什么、提交信息规范、PR 要求。
- `CODE_OF_CONDUCT.md`（Contributor Covenant 2.1 中文版）。
- `.github/ISSUE_TEMPLATE/`（bug / feature / 联系方式）与 `.github/PULL_REQUEST_TEMPLATE.md`。
- `SECURITY.md` 改为 GitHub Security Advisories 私密通道，并列出"已知边界不算漏洞"。

### 变更

- `ci.yml`：缺少 `DEEPSEEK_API_KEY` 时（典型是 fork 的 PR）e2e 以 `skipped` 计并打 warning，
  不再让整条流水线变红；未声明的跳过仍然阻断。
- `scripts/ci.ts`：新增声明式例外 `BAH_CI_ALLOW_SKIP`，只放宽严格模式的判定，
  不改变步骤标记（汇总里仍是 `○ skipped`），避免"看起来全绿"。
- `README.md`：改为开源门户结构（徽章、英文摘要、贡献与许可入口）。

### 项目能力（截至本版）

- 自研 cordis 风格插件内核，18 个包；30 个银行工具与七段工具管线，唯一阻断点在 `tools/pre-execute`。
- 三级权限（绿/黄/红）、一次性票据与五绑定、四接缝安全平面（sentry）、
  append-only 会话日志与 SHA-256 审计链（零签名报 `unsigned`，不报 verified）。
- `plan:dag` 计划编排（外部传入计划、校验、拓扑执行、断点续跑）与 saga 补偿；
  Web / 移动 H5 / 桌面端（Electron）/ IM 网关 / CLI 多渠道交付。
- 知识库 sidecar：条目级验签、ACL、时效窗与引用校验，缺席时工具 fail-closed。
- 三处拦截：pre-commit 门禁、pre-push 全链路、CI 严格模式；数字口径统一取自 `facts.md`。

### 已知限制

见 `README.md` §4「明确不做/未做」与 `docs/security-design.md` §4。主要几条：银行账本是内存仿真、
强验证是 mock、一进程一租户、plan 节点写操作自身不补偿、RAG 响应未做信封签名。
