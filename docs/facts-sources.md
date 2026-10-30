# BAH 事实数字取值说明

> 本文是 `facts.md` 与仓库内文档里数字的**唯一取值来源**。
> 改代码后重跑下表命令，先改本文，再改 `facts.md`，最后跑 `npx tsx scripts/verify-facts.ts`。
> 门禁 `verify-facts` 会从**命令侧重新计算**下列值，与本文和 `facts.md` 逐一比对；不一致退出码 1。

## 1. 机器可读块（门禁只读这一段）

<!-- facts:sources:start -->
gates=54
tools=21
plan_lines=2260
snapshot_files=11
snapshot_cases=48
coverage_covered=49571
coverage_total=55161
coverage_pct=89.87
coverage_package_ok=16
coverage_package_total=18
tests_main_files=349
tests_main_cases=4007
<!-- facts:sources:end -->

> `gates` 是**含本门禁**的非测试 `verify-*.ts` 个数（`run-gates` 按 `^verify-[\w-]+\.ts$` 发现；新增门禁后必须同步 +1）。
> `tests_main_files` / `tests_main_cases` 由 `npx vitest run` 输出，门禁**不重跑**（太慢），
> 只校验 `facts.md` 与本节一致；要改这两个数必须同批附上跑批输出。

## 2. 取值命令与实测输出

| 事实 | 值 | 命令 | 实测输出 |
|---|---|---|---|
| 门禁数 | **54** | `ls scripts/verify-*.ts \| grep -v '\.test\.ts$' \| wc -l` | 54（与 `run-gates` 的 `^verify-[\w-]+\.ts$` 同口径） |
| 工具数 | **21** | `grep -c "name: '" packages/bank/src/tools/specs.ts` | 21（与 `result-schemas.ts` 的出参键一一对应） |
| plan 非测试行数 | **2,260** | `packages/runtime/src/plan/*.ts` 去掉 `*.test.ts` 后逐文件计行 | 2,260 |
| 快照文件 / 用例 | **11 / 48** | `snapshots/**/*.test.ts` 计文件数，`it(` 计用例数 | 11 文件 / 48 例（`pnpm test:snapshot` 同值） |
| 覆盖率（行） | **89.87%** | `pnpm test:coverage:all`（与 `docs/coverage-baseline.json` 同口径） | 覆盖 49571 行 / 参与统计 55161 行 |
| 覆盖率（包） | **16/18** | 同上 | 只有 `memory-store` 72.68% 与 `eval` 46.93% 未达 80% |
| 主仓测试 | **349 文件 / 4007 例** | `NODE_EXTRA_CA_CERTS= npx vitest run --pool=forks` | 349 passed / 4007 例 |
| eval 包测试 | **22 文件 / 158 例** | `pnpm eval:unit` | 22 passed / 158 passed（**不是** `pnpm -F @bah/eval test`：该命令 cwd 在包内，会丢 `profiles/`） |
| web 测试 | **30 文件 / 409 例** | `pnpm test:web` | 30 passed / 409 passed |
| 快照跑批 | **11 文件 / 48 例** | `pnpm test:snapshot` | 11 passed / 48 passed |

## 3. 覆盖率只有一个值

`docs/coverage-baseline.json` 是机器产物：重跑覆盖率高时先更新它，再跑
`npx tsx scripts/gen-architecture.ts` 重生成 `architecture.md` / `algorithms.md` / `security-design.md` 的事实块。
**不许手改那三份文档的生成块。**

不同平台的 v8 行映射会把"没有执行行的文件"按物理行计入分母，导致本地报表与 CI 台账不可比；
引用时只取 `coverage-baseline.json` 的值，不要引用任一时点的本地控制台输出。
