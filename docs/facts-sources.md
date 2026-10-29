# BAH 事实数字唯一来源（2026-10-28 实测；S4 策略门禁与 policy-externalized 快照；可观测性 01 遥测内核）

> 本文是 `facts.md`、PPT、视频旁白、自评材料里数字的**唯一取值来源**。
> 改代码后重跑下表命令，先改本文，再改 `facts.md`，最后跑 `npx tsx scripts/verify-facts.ts`。
> 门禁 `verify-facts` 会从**命令侧重新计算**下列值，与本文和 `facts.md` 逐一比对；不一致退出码 1。
> 历史文档（`docs/next-actions-*`、`docs/preflight-*`、`文档归档/`）里的旧数**不在此列**，也不许改。

## 1. 机器可读块（门禁只读这一段）

<!-- facts:sources:start -->
gates=44
tools=16
plan_lines=2246
snapshot_files=8
snapshot_cases=34
coverage_covered=31233
coverage_total=34270
coverage_pct=91.14
coverage_package_ok=15
coverage_package_total=16
tests_main_files=250
tests_main_cases=2830
<!-- facts:sources:end -->

> `gates` 是**含本门禁**的 `scripts/verify-*.ts` 文件数（新增门禁后必须同步 +1）。
> `tests_main_files` / `tests_main_cases` 由 `npx vitest run` 输出，门禁**不重跑**（太慢），
> 只校验 `facts.md` 与本节一致；要改这两个数必须同批附上跑批输出。

## 2. 取值命令与实测输出（2026-10-27）

| 事实 | 值 | 命令 | 实测输出 |
|---|---|---|---|
| 门禁数 | **44** | `ls scripts/verify-*.ts \| wc -l` | 34 → `verify-facts.ts` 后 35 → `verify-docs-consistency.ts` 后 36；S4 新增 `verify-policy-{bundle,conformance,hardcode,registry}.ts` 后 40；可观测性 01 新增 `verify-telemetry.ts` 后 41；02 新增 `verify-observability.ts` 后 42；03 新增 `verify-observability-ui.ts` 后 43；移动 H5 01 新增 `verify-channel-capabilities.ts` 后 44；`run-gates` 输出 `44/44` |
| 工具数 | **16** | `grep -c "name: '" packages/bank/src/tools/specs.ts` | 16（与 `result-schemas.ts` 16 个出参键一一对应） |
| plan 非测试行数 | **2,246** | `packages/runtime/src/plan/*.ts` 去掉 `*.test.ts` 后逐文件计行 | 2,246（2026-10-27 复核） |
| 快照文件 / 用例 | **8 / 34** | `snapshots/**/*.test.ts` 计文件数，`it(` 计用例数 | 8 文件 / 34 例（`pnpm test:snapshot` 同值；S4 新增 `policy-externalized` 6 例） |
| 覆盖率（行） | **91.14%** | `pnpm test:coverage:all`（**CI / Ubuntu 口径**） | 覆盖 31233 行 / 参与统计 34270 行（2026-10-28 CI run 40631263792，端口守卫新增 36 行后） |
| 覆盖率（包） | **15/16** | 同上 | 只有 `eval` 53.20% 未达 80%；`memory-store` 89.40% 已达标 |
| 主仓测试 | **250 文件 / 2830 例** | `NODE_EXTRA_CA_CERTS= npx vitest run` | 250 passed / 2830 例（2026-10-29 移动 H5 01 收口复跑；相对上一批新增渠道能力位/HTTP 适配器工厂/计划待办与影响面派生/静态白名单/移动渠道装配七组用例） |
| eval 包测试 | **22 文件 / 158 例** | `pnpm eval:unit` | 22 passed / 158 passed（**不是** `pnpm -F @bah/eval test`：该命令 cwd 在包内，会丢 `profiles/`） |
| web 测试 | **12 文件 / 139 例** | `pnpm test:web` | 12 passed / 139 passed（03 新增 observe/observability/transport.main 接线四组用例） |
| 快照跑批 | **8 文件 / 34 例** | `pnpm test:snapshot` | 8 passed / 34 passed |

## 3. 覆盖率为什么只有一个值

`31233 / 34270 = 91.14%`。**只能用 CI 口径**：本机（Windows）报表会把没有执行行的文件按**物理行**计入分母（`packages/memory-store/src/types.ts` 精确 257 物理行，本机报表记为 `0/257`），分母虚高约 1900 行、行口径虚低约 5 个百分点。两个候选归因都已用对照实验排除：把 230 个 CRLF/mixed 文件按索引改成 LF 后复跑、以及改用 Node 22.19（与 CI 同版本）复跑，本机报表都仍是 31227/36169。差异在 Windows 下的 v8 行映射/文件枚举（无执行行文件是否计入分母），具体触发点尚未定位；两平台 covered 行数几乎一致（CI 31233 vs 本机 31227，差 6 行来自平台分支），差异全在分母。

因此 **本机时点值 86.33%（31227/36169）与更早的 86.32%（31191/36133）、86.06%（31093/36131）都已作废**，不要再引用——它们不是"覆盖率下降"，是分母算法在 Node 22.17 下失真。再往前 `85.84%` 有两个不同分母（29958/34898 与 30992/36106）、`85.83%`（29843/34771）与 `84.49%`（29163/34517）更早，同属本机口径，只作历史记录。
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
