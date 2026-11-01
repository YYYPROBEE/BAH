# BAH 工程纪律

## 合规底线
1. 不引入 dsh 源码：仓库中不出现 @deepseek-ai/* 依赖、不 vendor 其包、不复制其文件。
2. 不照抄 dsh 的文件/符号命名，命名服务银行领域语义。
3. 允许阅读 dsh 公开文档理解机制，据此自行设计实现。
4. sentry-dsh-plugin / caai-sentry 为自有工程，可自由迁移。
5. 源码根 NOTICE.md 明示独立性；引入任何第三方组件逐项标注。

## 编码纪律
1. 注册即可逆：一切贡献走 effect() / on()，返回 disposer。
2. waterfall 必须调 next()（除非有意拥有该判决）。
3. 改主循环 = 破坏性变更：必须同步更新架构文档并跑全量快照。
4. 插件不硬编码可调项：随部署变化的取值都是校验过的 Config 字段。
5. 错误必须结构化：类型化失败 + 可读理由码；禁止静默吞错。
6. 判别标签 switch：封闭联合以 assertNever 收尾。

## 文档边界

留在树上的只有落地文档（`docs/*.md`）、`facts.md` 与可执行的门禁/演示脚本。
过程台账、证据原件、交接单、演练单与一次性复审稿**不随仓库分发**：需要保留时放仓库外的归档目录，
不要放回 `docs/`。`verify-docs-consistency` 的路径规则会拦在提交前。

代码注释不引用仓库外的过程文件（工单编号、台账、证据、交接单）；需要背景时看对应的实现文档。

## 门禁

三处拦截，力度递减，按实物如实记录：

| 时机 | 机制 | 跑什么 | 失败后果 |
|---|---|---|---|
| 提交前 | `.githooks/pre-commit` | `pnpm gate`（54 项） | 拒绝提交 |
| 推送前 | `.githooks/pre-push` | `pnpm check`（14 步） | 拒绝推送 |
| 推送后 | `.github/workflows/ci.yml` / `security.yml` | `pnpm check:ci`（严格模式）+ npm audit（pip-audit 先收集基线） | 记录为红色 run |

项数与步数以 `facts.md` 为准（`verify-facts` 按 `^verify-[\w-]+\.ts$` 重算门禁数，**不含** `*.test.ts`）；
新增门禁必须同批改 `facts.md`、`docs/facts-sources.md` 与上表，否则 `verify-facts` 红。

钩子通过 `core.hooksPath` 生效（`pnpm install` 时的 `prepare` 会自动设置，也可手动
`git config core.hooksPath .githooks`）。

**远端 CI 是事后复核，不是合并闸门。** 仓库未启用分支保护，没有必需状态检查；
push 之后 CI 必跑，红了要靠人看见。启用分支保护或规则集后，本节才改为「失败即阻断合并」。

钩子只挡疏忽，不挡有意绕过；代码评审仍是最后一道。
