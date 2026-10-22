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

## 门禁

三处拦截，力度递减，按实物如实记录：

| 时机 | 机制 | 跑什么 | 失败后果 |
|---|---|---|---|
| 提交前 | `.githooks/pre-commit` | `pnpm gate`（25 项） | 拒绝提交 |
| 推送前 | `.githooks/pre-push` | `pnpm check`（10 步） | 拒绝推送 |
| 推送后 | `.github/workflows/ci.yml` | `pnpm check:ci`（严格模式） | 记录为红色 run |

钩子通过 `core.hooksPath` 生效（`pnpm install` 时的 `prepare` 会自动设置，也可手动
`git config core.hooksPath .githooks`）。

**这不叫「阻断合并」。** 本仓库为私有仓，GitHub Free 不支持分支保护，因此没有必需状态检查、
也没有 PR 合并闸门——远端 CI 是**事后复核**：push 之后必跑，红了要靠人看见。将来转为公开仓
（或升级 Pro）后补上分支保护，本节才改为「失败即阻断合并」。

已知敞开两处，写在此处而非藏在自评里：

1. `git commit --no-verify` / `git push --no-verify` 可绕过钩子——钩子挡疏忽，不挡恶意；
2. 无分支保护，直接 push 到 `main` 不会被拒绝。
