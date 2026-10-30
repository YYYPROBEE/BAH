# 场景 5 施工基线（P0）

- 记录时间：2026-10-30 01:04:43 +0800
- HEAD：1c369b337413e54002a68c4e5da6b98cfb25d5eb
- 分支：main

## 工作树状态（施工开始时，含他人在途改动）
```
 M docs/algorithms.md
 M docs/architecture.md
 M docs/bank-tools.md
 M docs/roadmap.md
 M docs/security-design.md
 M facts.md
 M packages/bank/src/core/index.ts
 M packages/bank/src/core/mock.test.ts
 M packages/bank/src/core/mock.ts
 M packages/bank/src/forge/index.ts
 M packages/bank/src/tools/catalog.test.ts
 M packages/bank/src/tools/dto.ts
 M packages/bank/src/tools/governance.ts
 M packages/bank/src/tools/presenters.ts
 M packages/bank/src/tools/result-schemas.ts
 M packages/bank/src/tools/wealth.test.ts
 M packages/bank/src/tools/wealth.ts
 M packages/eval/src/metrics/aggregate.ts
 M packages/eval/src/scenario/runner.ts
 M packages/eval/src/scenario/spec.ts
 M packages/eval/src/scenario/validate.ts
 M packages/eval/src/scenarios/index.ts
 M packages/eval/src/scenarios/p/index.ts
 M packages/eval/tests/scenario/runner.test.ts
M  packages/host/src/boot/plugins/web/auth/identity.test.ts
M  packages/host/src/boot/plugins/web/auth/session-store.test.ts
M  packages/host/src/boot/plugins/web/handlers/auth.test.ts
A  packages/host/src/boot/plugins/web/handlers/handoff.test.ts
M  packages/host/src/boot/plugins/web/handoff-store.test.ts
M  packages/host/src/boot/plugins/web/handoff.test.ts
 M packages/llm/src/demo/router.test.ts
 M packages/llm/src/demo/router.ts
M  packages/telemetry/src/metrics.test.ts
M  scripts/assertion-baseline.json
?? .ci-artifacts-pre-sub/
?? docs/evidence/2026-10-30-sub-baseline/
?? packages/bank/src/core/suitability.test.ts
?? packages/bank/src/core/suitability.ts
```

## 7 份含工具目录的快照 sha256
```
777711eb6e17ff7e36406a2f2f8dc589725c466d3fe78b0e9f41a8eddeb81252 *snapshots/compaction/session.jsonl
96eec7a40094ee8843c6b325a41ce6fcb13852f183e88b342d28053df6a2c820 *snapshots/cross-scene/session.jsonl
373b94545e264721390f0471db391d0eed2a5cd7bf646eeb8d6ad35e46d2cc9c *snapshots/entity-slots/session.jsonl
2ee8996b7c3c456edba2639aa021727aee5e3794e68f4413bd59321c4e74f072 *snapshots/headless-basic/session.jsonl
f748c4a9eb6c36b138a9dff66e08443386c539f2bf81c2b30deda2f99340aa60 *snapshots/policy-externalized/session.jsonl
fcd17e8a5d70741790c53f5781e17719fdaaf08c0e8b43448e3f48c15bea7832 *snapshots/sandbox-compute/session.jsonl
cff84406b3515ba5ee25d46a8aeeab9d3d6843e68f428b8ca53646459b23fcd1 *snapshots/web-channel/session.jsonl
```

## 基线检查（施工开始时）
```
pnpm check → 第 1/14 步 typecheck 失败：
packages/eval/src/scenarios/index.ts(13,29): error TS2307: Cannot find module './u/index.ts'
原因：并行线在途（只改索引、目录未建），与本单无关。
日志：.ci-artifacts-pre-sub/check.log
```
