# BAH 事实数字唯一来源（2026-10-27 实测）

> 本文是 `facts.md`、PPT、视频旁白、自评材料里数字的**唯一取值来源**。
> 改代码后重跑下表命令，先改本文，再改 `facts.md`，最后跑 `npx tsx scripts/verify-facts.ts`。
> 门禁 `verify-facts` 会从**命令侧重新计算**下列值，与本文和 `facts.md` 逐一比对；不一致退出码 1。
> 历史文档（`docs/next-actions-*`、`docs/preflight-*`、`文档归档/`）里的旧数**不在此列**，也不许改。

## 1. 机器可读块（门禁只读这一段）

<!-- facts:sources:start -->
gates=35
tools=16
plan_lines=2208
snapshot_files=5
snapshot_cases=18
coverage_covered=29163
coverage_total=34517
coverage_pct=84.49
coverage_package_ok=14
coverage_package_total=16
tests_main_files=198
tests_main_cases=1995
<!-- facts:sources:end -->

> `gates` 是**含本门禁**的 `scripts/verify-*.ts` 文件数（新增门禁后必须同步 +1）。
> `tests_main_files` / `tests_main_cases` 由 `npx vitest run` 输出，门禁**不重跑**（太慢），
> 只校验 `facts.md` 与本节一致；要改这两个数必须同批附上跑批输出。

## 2. 取值命令与实测输出（2026-10-27）

| 事实 | 值 | 命令 | 实测输出 |
|---|---|---|---|
| 门禁数 | **35** | `Get-ChildItem scripts -Filter "verify-*.ts" \| Measure-Object` | 34 → 加 `verify-facts.ts` 后 35；`run-gates` 输出 `35/35` |
| 工具数 | **16** | `grep -c "name: '" packages/bank/src/tools/specs.ts` | 16（与 `result-schemas.ts` 16 个出参键一一对应） |
| plan 非测试行数 | **2,208** | `packages/runtime/src/plan/*.ts` 去掉 `*.test.ts` 后逐文件计行 | 2,208（2026-10-27 复核） |
| 快照文件 / 用例 | **5 / 18** | `snapshots/**/*.test.ts` 计文件数，`it(` 计用例数 | 5 文件 / 18 例（`pnpm test:snapshot` 同值） |
| 覆盖率（行） | **84.49%** | `NODE_EXTRA_CA_CERTS= pnpm test:coverage:all` | 覆盖 29163 行 / 参与统计 34517 行 |
| 覆盖率（包） | **14/16** | 同上 | `memory-store` 72.71%、`eval` 40.73% 未达 80% |
| 主仓测试 | **198 文件 / 1995 例** | `NODE_EXTRA_CA_CERTS= npx vitest run` | 198 passed / 1995 passed |
| eval 包测试 | **22 文件 / 158 例** | `pnpm eval:unit` | 22 passed / 158 passed（**不是** `pnpm -F @bah/eval test`：该命令 cwd 在包内，会丢 `profiles/`） |
| web 测试 | **7 文件 / 55 例** | `pnpm test:web` | 7 passed / 55 passed |
| 快照跑批 | **5 文件 / 18 例** | `pnpm test:snapshot` | 5 passed / 18 passed |

## 3. 覆盖率为什么只有一个值

`29163 / 34517 = 84.4897%`，四舍五入两位小数 = **84.49%**；`84.48%` 是截尾旧值，已在 2026-10-27 全部替换。
`docs/coverage-baseline.json` 是机器产物：重跑覆盖率高时先更新它，再跑
`npx tsx scripts/gen-architecture.ts` 重生成 `architecture.md` / `algorithms.md` / `security-design.md` 的事实块。
**不许手改那三份文档的生成块。**

## 4. 不在本表、也不许改的数

| 文件 | 原因 |
|---|---|
| `docs/next-actions-2026-10-23.md` | 2026-10-23 的决策记录，`14 个工具` 是当时事实 |
| `docs/preflight-2026-10-25.md` | 2026-10-25 的开工前体检记录 |
| `docs/audit-command-16.md`、`docs/next-three-*` | 历史交接件 |
| `文档归档/**` | 归档稿，改数会让复核者失去时间线 |
| `PROGRESS.md` 的既有小节 | 只追加新小节，不改历史数字 |
