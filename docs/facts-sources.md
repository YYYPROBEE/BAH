# BAH 事实数字唯一来源（2026-10-27 实测；主仓测试 2026-10-28 复跑）

> 本文是 `facts.md`、PPT、视频旁白、自评材料里数字的**唯一取值来源**。
> 改代码后重跑下表命令，先改本文，再改 `facts.md`，最后跑 `npx tsx scripts/verify-facts.ts`。
> 门禁 `verify-facts` 会从**命令侧重新计算**下列值，与本文和 `facts.md` 逐一比对；不一致退出码 1。
> 历史文档（`docs/next-actions-*`、`docs/preflight-*`、`文档归档/`）里的旧数**不在此列**，也不许改。

## 1. 机器可读块（门禁只读这一段）

<!-- facts:sources:start -->
gates=36
tools=16
plan_lines=2246
snapshot_files=6
snapshot_cases=23
coverage_covered=31197
coverage_total=34234
coverage_pct=91.13
coverage_package_ok=15
coverage_package_total=16
tests_main_files=205
tests_main_cases=2115
<!-- facts:sources:end -->

> `gates` 是**含本门禁**的 `scripts/verify-*.ts` 文件数（新增门禁后必须同步 +1）。
> `tests_main_files` / `tests_main_cases` 由 `npx vitest run` 输出，门禁**不重跑**（太慢），
> 只校验 `facts.md` 与本节一致；要改这两个数必须同批附上跑批输出。

## 2. 取值命令与实测输出（2026-10-27）

| 事实 | 值 | 命令 | 实测输出 |
|---|---|---|---|
| 门禁数 | **36** | `Get-ChildItem scripts -Filter "verify-*.ts" \| Measure-Object` | 34 → `verify-facts.ts` 后 35 → `verify-docs-consistency.ts` 后 36；`run-gates` 输出 `36/36` |
| 工具数 | **16** | `grep -c "name: '" packages/bank/src/tools/specs.ts` | 16（与 `result-schemas.ts` 16 个出参键一一对应） |
| plan 非测试行数 | **2,246** | `packages/runtime/src/plan/*.ts` 去掉 `*.test.ts` 后逐文件计行 | 2,246（2026-10-27 复核） |
| 快照文件 / 用例 | **6 / 23** | `snapshots/**/*.test.ts` 计文件数，`it(` 计用例数 | 6 文件 / 23 例（`pnpm test:snapshot` 同值） |
| 覆盖率（行） | **91.13%** | `pnpm test:coverage:all`（**CI / Ubuntu 口径**） | 覆盖 31197 行 / 参与统计 34234 行（2026-10-27 深夜轮次，CI run 40537315058） |
| 覆盖率（包） | **15/16** | 同上 | 只有 `eval` 53.20% 未达 80%；`memory-store` 89.40% 已达标 |
| 主仓测试 | **205 文件 / 2115 例** | `NODE_EXTRA_CA_CERTS= npx vitest run` | 205 passed / 2115 例（2026-10-28 复跑，端口守卫新增 3 例；门禁不重跑测试，只校验本文与 facts.md 一致） |
| eval 包测试 | **22 文件 / 158 例** | `pnpm eval:unit` | 22 passed / 158 passed（**不是** `pnpm -F @bah/eval test`：该命令 cwd 在包内，会丢 `profiles/`） |
| web 测试 | **7 文件 / 55 例** | `pnpm test:web` | 7 passed / 55 passed |
| 快照跑批 | **6 文件 / 23 例** | `pnpm test:snapshot` | 6 passed / 23 passed |

## 3. 覆盖率为什么只有一个值

`31197 / 34234 = 91.13%`。**只能用 CI 口径**：Windows 检出为 CRLF 时 v8 行映射会退化，把无可执行行的文件按**物理行**计入分母（`packages/memory-store/src/types.ts` 精确 257 物理行，Windows 报表里记为 `0/257`），分母虚高约 1900 行、行口径虚低约 5 个百分点；两平台的 covered 行数几乎一致（31197 vs 31191，差 6 行来自平台分支），差异全在分母。

因此 **2026-10-27 在 Windows 上测出的 86.32%（31191/36133）与更早的 86.06%（31093/36131）都已作废**，不要再引用——它们不是"覆盖率下降"，是分母算法在 CRLF 检出下失真。再往前 `85.84%` 有两个不同分母（29958/34898 与 30992/36106）、`85.83%`（29843/34771）与 `84.49%`（29163/34517）更早，同属 Windows 口径，只作历史记录。
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
