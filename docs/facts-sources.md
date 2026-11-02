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
snapshot_files=13
snapshot_cases=60
coverage_covered=60053
coverage_total=61636
coverage_pct=97.43
coverage_package_ok=18
coverage_package_total=18
tests_main_files=446
tests_main_cases=5148
<!-- facts:sources:end -->

> `gates` 是**含本门禁**的 `scripts/verify-*.ts` 文件数（新增门禁后必须同步 +1）。
> `tests_main_files` / `tests_main_cases` 由 `npx vitest run` 输出，门禁**不重跑**（太慢），
> 只校验 `facts.md` 与本节一致；要改这两个数必须同批附上跑批输出。

## 2. 取值命令与实测输出（2026-10-27）

| 事实 | 值 | 命令 | 实测输出 |
|---|---|---|---|
| 门禁数 | **53** | `ls scripts/verify-*.ts \| grep -v '\.test\.ts$' \| wc -l` | 以本命令实测为准 |
| 工具数 | **30** | `grep -c "name: '" packages/bank/src/tools/specs.ts` | 30（与 `result-schemas.ts` 30 个出参键一一对应；官方子能力补齐新增 7 个；2026-11-01 新增 `fund_lock` 与 `password_change`） |
| plan 非测试行数 | **2,260** | `packages/runtime/src/plan/*.ts` 去掉 `*.test.ts` 后逐文件计行 | 2,260（2026-10-30 合流后重算） |
| 快照文件 / 用例 | **13 / 60** | `snapshots/**/*.test.ts` 计文件数，`it(` 计用例数 | 13 文件 / 60 例（`pnpm test:snapshot` 同值；新增 `birthday-reminder` 场景 1 文件 6 例：3 天窗口 / 同日幂等 / 生日当天不重复 / 通知帧回放 / 负控） |
| 覆盖率（行） | **97.43%** | `pnpm test:coverage:all` | 覆盖 60053 行 / 参与统计 61636 行（2026-11-02 CI 跑批实测） |
| 覆盖率（包） | **18/18** | 同上 | 18 个包全部 ≥80%，最低 `saga` 90.34% |
| 主仓测试 | **446 文件 / 5148 例** | `NODE_EXTRA_CA_CERTS= npx vitest run` | 446 文件 / 5148 例（2026-11-02 全量实测；较 444/5092 新增 `web/handlers/sessions.test.ts` 32 例与 `im-gateway/test/gateway-history.test.ts` 24 例。**Windows 全量跑时 `apps/im-gateway/test/supervisor.test.ts` 有偶发时序失败（单文件重跑 17/17 绿），与用例数无关**） |
| eval 包测试 | **22 文件 / 158 例** | `pnpm eval:unit` | 22 passed / 158 passed（**不是** `pnpm -F @bah/eval test`：该命令 cwd 在包内，会丢 `profiles/`） |
| web 测试 | **49 文件 / 592 例** | `pnpm test:web` | 49 文件 / 592 例，**全绿**（2026-11-02 实测；较 47/550 新增 `views/history.test.js` 27 例与 `mobile/history-sheet.test.js` 14 例，覆盖历史列表、只读回放与“不渲染审批按钮”） |
| 快照跑批 | **13 文件 / 60 例** | `pnpm test:snapshot` | **60 passed / 0 failed**（2026-11-01 重录后回放；新增 `birthday-reminder` 6 例；`plan` / `cross-scene` / `subscription-reminder` / `birthday-reminder` 的录制夹具用 overlay 显式放行审批，生产 profile 仍 `responder: none`） |

## 3. 覆盖率口径

**只有一个口径**：CI（Ubuntu / Node 22.19）上 `pnpm test:coverage:all` 的实测值。
分母 = `packages/*/src/**/*.ts`，去掉测试文件、纯类型模块与纯 barrel。

2026-11-02 实测：**97.43%（60053/61636）**，包口径 **18/18**（18 个包全部 ≥80%，最低 `saga` 90.34%）。

上一版是 89.87%（49571/55161）、包 16/18。两处**配置缺陷**把数字压低了（都在 `vitest.coverage.config.ts`）：

1. 评测包的用例落在 `packages/eval/tests/`，根配置的 include 只扫 `packages/*/src/**/*.test.ts`、
   扫不到它们，而分母含 `eval/src`——等于"分母算了 eval、分子没跑 eval"。
   修后 eval 由 46.93% 回到 92.21%。
2. `packages/memory-store/src/types.ts`（纯类型）与 `src/index.ts`（纯 barrel）
   在本机 v8 下按物理行计入分母、报 0 覆盖假红。修后 memory-store 由 72.68% 回到 96.65%。

`docs/coverage-baseline.json` 是机器产物：重跑覆盖率高时先更新它，再跑
`npx tsx scripts/gen-architecture.ts` 重生成 `architecture.md` / `algorithms.md` / `security-design.md` 的事实块。
**不许手改那三份文档的生成块。**
