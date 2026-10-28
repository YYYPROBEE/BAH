# bank-tier 1.0.0

## 2026-10-28 · 首个生产版本

- 与 `packages/bank/src/tools/tier.ts` 的 legacy 判定**逐条等价**：
  - 日累计含本笔 `> min(core 限额, Config 限额)` → `raise: red` / `daily-limit`（严格大于）；
  - 收款人 `binding == "new"` → `raise: red` / `new-payee`；
  - 组合风险 `riskyCallsInTurn >= riskyCallThreshold` 且理由仍为 `declared` → 保持级别、理由改
    `risky-calls`；**绿级不改**（绿级工具不进策略，规则里再守一道，避免与 legacy 分叉）。
- 不进入 bundle 的硬不变量（仍在 `tier.ts` / 治理平面）：未绑定身份 deny、强验证锁定 deny、
  预检失败、生效上限取 `min(core, config)`、红级挑战。
- 参数 `riskyCallThreshold` 只声明名字/边界（1..100），值来自 `bank:tools` 配置。

## 已知边界

- 规则里没有数值字面量：金额上限与阈值全部走 `limits.*` / `params.*`；
- 若要改"新收款人是否升红"，本目录**不可就地修改**——复制到 `1.1.0/` 并按 major 规则评估。
