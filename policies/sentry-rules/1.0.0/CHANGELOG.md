# sentry-rules 1.0.0

- 首次外置：13 条内置危险参数规则（CMD-001..008 / NET-001..002 / SQL-001 / PRV-001..002）
  从 `@bah/safety` 的 `BUILTIN_RULES` 搬入 bundle，ID/族/说明/正则逐字一致。
- 每条规则带 2 正例 + 2 反例；`pnpm policy:test` 与 `verify-policy-conformance` 逐条跑。
- 安全子集：正则 ≤256 字符、禁止反向引用/lookbehind/嵌套量词/`.*.*`、字符类 ≤128、flags ⊆ {i,m,s}。
- NET-001 的 demo/example/mock 校准位仍由部署配置（`rules.demoWhitelist`）控制，不写进 bundle。
