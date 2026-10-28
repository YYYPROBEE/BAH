# 11 快照重录 diff 说明（S3/S4 已审；S5/P1 零变化）

- 现状：`snapshots/` 共 **8 文件 / 34 例**（`pnpm test:snapshot` 同值）。
- S3 切换 `engine: bundle` 时重录了 7 个既有场景（CR-06），逐条审 diff：
  只有计划内字段（`tier/decided` 增 `policyVersion/ruleIds/paramsDigest/engineSource/evidence`）
  与计划内事件（`policy/bundle-loaded`），会话/模型可见内容零 diff。
  证据：`s4-snapshot-evidence.log`、`s2-s3-construction-and-review.md` §3。
- S4 新增 `policy-externalized`（6 例）：断言
  `tier/decided = red + daily-limit + TR-004-single-large + bank-tier-demo/1.1.0`，
  同一 evidence 输入给 legacy 是 yellow；篡改 evidence 的 replay 负控必红。
- S4 第二轮（`1fb7579`）：`tier.test.ts` 补 1 例 min 方向边界（2404 → 2405），快照不变。
- **P1（覆盖率补测）**：只新增单测与两处导出，未动会话/模型可见行为；快照 8/34 不变。
- **S5（sentry.rules）**：`sentry/decision` 只进审计链、不进会话事件；`profiles/*` 未切
  `rules.engine: bundle`。快照 8/34 不变（两次跑批一致：见 `10-snapshot.log`）。
- 结论：快照 diff 只含计划内字段/事件；S5 与 P1 均为零变化。
