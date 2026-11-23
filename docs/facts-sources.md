# BAH 事实数字唯一来源

> 本文是 `facts.md`、PPT、视频旁白里数字的**唯一取值来源**。
> 改代码后重跑下表命令，先改本文，再改 `facts.md`，最后跑 `npx tsx scripts/verify-facts.ts`。
> 门禁 `verify-facts` 会从**命令侧重新计算**下列值，与本文和 `facts.md` 逐一比对；不一致退出码 1。
> 历史文档里的旧数**不在此列**，也不许改。

## 1. 机器可读块（门禁只读这一段）

<!-- facts:sources:start -->
gates=53
tools=30
plan_lines=2260
snapshot_files=14
snapshot_cases=64
coverage_covered=60710
coverage_total=61734
coverage_pct=98.34
coverage_package_ok=18
coverage_package_total=18
tests_main_files=458
tests_main_cases=5307
<!-- facts:sources:end -->

> `gates` 是**含本门禁**的 `scripts/verify-*.ts` 文件数（新增门禁后必须同步 +1）。
> `tests_main_files` / `tests_main_cases` 由 `npx vitest run` 输出，门禁**不重跑**（太慢），
> 只校验 `facts.md` 与本节一致；要改这两个数必须同批附上跑批输出。

## 2. 取值命令与实测输出（随事实更新，当前 2026-11-15）

| 事实 | 值 | 命令 | 实测输出 |
|---|---|---|---|
| 门禁数 | **53** | `ls scripts/verify-*.ts \| grep -v '\.test\.ts$' \| wc -l` | 以本命令实测为准 |
| 工具数 | **30** | `grep -c "name: '" packages/bank/src/tools/specs.ts` | 30（与 `result-schemas.ts` 30 个出参键一一对应；官方子能力补齐新增 7 个；2026-11-01 新增 `fund_lock` 与 `password_change`） |
| plan 非测试行数 | **2,260** | `packages/runtime/src/plan/*.ts` 去掉 `*.test.ts` 后逐文件计行 | 2,260（2026-10-30 合流后重算） |
| 快照文件 / 用例 | **14 / 64** | `snapshots/**/*.test.ts` 计文件数，`it(` 计用例数 | 14 文件 / 64 例（`pnpm test:snapshot` 同值）；`scheduled-funds` 1 文件 4 例：`transfer_schedule` 入口、`fund_lock` 三动作、到期代签**成功**（武装预授权，2026-11-22 重录；修复前被 `challenge-required` 阻断）、篡改负控。它同时是 `fund_lock` 票据金额缺陷的回归 |
| 覆盖率（行） | **98.34%** | `pnpm test:coverage:all` | 覆盖 60710 行 / 参与统计 61734 行（2026-11-23 CI 跑批实测；数值取自 CI 注解 `coverage 60710/61734`，见 `docs/coverage-baseline.json` 的 note） |
| 覆盖率（包） | **18/18** | 同上 | 18 个包全部 ≥80%，最低 `saga` 90.34% |
| 主仓测试 | **458 文件 / 5307 例** | `NODE_EXTRA_CA_CERTS= npx vitest run` | 458 文件 / 5307 例，全绿（2026-11-23 全量实测：较 2026-11-03 台账 455/5283 增 3 文件 / 24 例。**拆账**：7 例 + 2 文件为台账日期后的存量漂移（本轮复审登记），17 例 + 1 文件为本轮 F-01 修复新增（审批预授权 7、回执单测 6、跨重启集成 2、密钥配置 2）。**Windows 全量跑时 `apps/im-gateway/test/supervisor.test.ts` 有偶发时序失败（单文件重跑绿），与用例数无关**） |
| eval 包测试 | **22 文件 / 158 例** | `pnpm eval:unit` | 22 passed / 158 passed（**不是** `pnpm -F @bah/eval test`：该命令 cwd 在包内，会丢 `profiles/`） |
| web 测试 | **49 文件 / 610 例** | `pnpm test:web` | 49 文件 / 610 例，**全绿**（2026-11-03 实测（清理线）；较 47/550 新增 `views/history.test.js` 27 例、`mobile/history-sheet.test.js` 14 例与批内 18 例，覆盖历史列表、只读回放与“不渲染审批按钮”） |
| 快照跑批 | **14 文件 / 64 例** | `pnpm test:snapshot` | **64 passed / 0 failed**（2026-11-22 重录 `scheduled-funds` 后全量回放；该场景的到期腿从"被挑战校验阻断"改为"凭武装预授权成功"，4 例断言同批更新；`plan` / `cross-scene` / `subscription-reminder` / `birthday-reminder` / `scheduled-funds` 的录制夹具用 overlay 显式放行审批，生产 profile 仍 `responder: none`） |

## 3. 覆盖率口径

**只有一个口径**：CI（Ubuntu / Node 22.19）上 `pnpm test:coverage:all` 的实测值。
分母 = `packages/*/src/**/*.ts`，去掉测试文件、纯类型模块与纯 barrel。

2026-11-23 CI 实测：**98.34%（60710/61734）**，包口径 **18/18**（18 个包全部 ≥80%，最低 `saga` 90.34%）。
相对上一版 60540/61576：F-01 新增可执行行全部被测试覆盖，覆盖行 +170、参与统计行 +158。
本机 Windows 分母 62254 比 CI 多 520 行（无执行行文件按物理行计入），**不能直接用本机数**。
相对上一版 97.43%（60053/61636）：补齐拒绝面与 plan 唤醒环用例后覆盖行 +487、参与统计行 -60。

上一版是 89.87%（49571/55161）、包 16/18。两处**配置缺陷**把数字压低了（都在 `vitest.coverage.config.ts`）：

1. 评测包的用例落在 `packages/eval/tests/`，根配置的 include 只扫 `packages/*/src/**/*.test.ts`、
   扫不到它们，而分母含 `eval/src`——等于"分母算了 eval、分子没跑 eval"。
   修后 eval 由 46.93% 回到 92.21%。
2. `packages/memory-store/src/types.ts`（纯类型）与 `src/index.ts`（纯 barrel）
   在本机 v8 下按物理行计入分母、报 0 覆盖假红。修后 memory-store 由 72.68% 回到 96.65%。

`docs/coverage-baseline.json` 是机器产物：重跑覆盖率高时先更新它，再跑
`npx tsx scripts/gen-architecture.ts` 重生成 `architecture.md` / `algorithms.md` / `security-design.md` 的事实块。
**不许手改那三份文档的生成块。**
