# BAH 事实数字唯一来源（2026-10-28 实测；S4 策略门禁与 policy-externalized 快照；可观测性 01 遥测内核）

> 本文是 `facts.md`、PPT、视频旁白、自评材料里数字的**唯一取值来源**。
> 改代码后重跑下表命令，先改本文，再改 `facts.md`，最后跑 `npx tsx scripts/verify-facts.ts`。
> 门禁 `verify-facts` 会从**命令侧重新计算**下列值，与本文和 `facts.md` 逐一比对；不一致退出码 1。
> 历史文档（`docs/next-actions-*`、`docs/preflight-*`、`文档归档/`）里的旧数**不在此列**，也不许改。

## 1. 机器可读块（门禁只读这一段）

<!-- facts:sources:start -->
gates=54
tools=30
plan_lines=2260
snapshot_files=13
snapshot_cases=60
coverage_covered=49571
coverage_total=55161
coverage_pct=89.87
coverage_package_ok=16
coverage_package_total=18
tests_main_files=443
tests_main_cases=5084
<!-- facts:sources:end -->

> `gates` 是**含本门禁**的 `scripts/verify-*.ts` 文件数（新增门禁后必须同步 +1）。
> `tests_main_files` / `tests_main_cases` 由 `npx vitest run` 输出，门禁**不重跑**（太慢），
> 只校验 `facts.md` 与本节一致；要改这两个数必须同批附上跑批输出。

## 2. 取值命令与实测输出（2026-10-27）

| 事实 | 值 | 命令 | 实测输出 |
|---|---|---|---|
| 门禁数 | **54** | `ls scripts/verify-*.ts \| grep -v '\.test\.ts$' \| wc -l` | 34 → `verify-facts.ts` 后 35 → … → 移动 H5 03 后 46；租户与鉴权 01–04 新增 `verify-tenant-scope.ts` / `verify-tenant-isolation.ts` / `verify-authz-coverage.ts` 后 49；人机接管 01 新增 `verify-handoff-wiring.ts` 后 50；桌面端 02 新增 `verify-desktop-shell.ts` 后 51；IM 网关 02 新增 `verify-im-gateway.ts` 后 52；主动能力线新增 `verify-proactive.ts` / `verify-audit-cli.ts` / `verify-frame-closure.ts` 后 54 |
| 工具数 | **30** | `grep -c "name: '" packages/bank/src/tools/specs.ts` | 30（与 `result-schemas.ts` 30 个出参键一一对应；官方子能力补齐新增 7 个；2026-11-01 新增 `fund_lock` 与 `password_change`） |
| plan 非测试行数 | **2,260** | `packages/runtime/src/plan/*.ts` 去掉 `*.test.ts` 后逐文件计行 | 2,260（2026-10-30 合流后重算） |
| 快照文件 / 用例 | **13 / 60** | `snapshots/**/*.test.ts` 计文件数，`it(` 计用例数 | 13 文件 / 60 例（`pnpm test:snapshot` 同值；04 单新增 `birthday-reminder` 场景 1 文件 6 例：3 天窗口 / 同日幂等 / 生日当天不重复 / 通知帧回放 / 负控） |
| 覆盖率（行） | **89.87%** | `pnpm test:coverage:all`（本机汇总口径） | 覆盖 49571 行 / 参与统计 55161 行（2026-10-30 五线合流后复跑） |
| 覆盖率（包） | **16/18** | 同上 | 只有 `memory-store` 72.68% 与 `eval` 46.93% 未达 80% |
| 主仓测试 | **443 文件 / 5084 例** | `NODE_EXTRA_CA_CERTS= npx vitest run` | 443 文件 / 5084 例，**全绿**（2026-11-01 全量实测；较 442/5073 新增 `endpoints.contract.test.ts` 4 例与测试缺口补测 7 例） |
| eval 包测试 | **22 文件 / 158 例** | `pnpm eval:unit` | 22 passed / 158 passed（**不是** `pnpm -F @bah/eval test`：该命令 cwd 在包内，会丢 `profiles/`） |
| web 测试 | **47 文件 / 550 例** | `pnpm test:web` | 47 文件 / 550 例，**全绿**（2026-11-01 复审修复后实测；新增 `apps/web/src/password.test.js` 2 例，覆盖交接票 `?ticket=` 预填与地址栏清理） |
| 快照跑批 | **13 文件 / 60 例** | `pnpm test:snapshot` | **60 passed / 0 failed**（2026-11-01 04/05 单重录后回放；新增 `birthday-reminder` 6 例；`plan` / `cross-scene` / `subscription-reminder` / `birthday-reminder` 的录制夹具用 overlay 显式放行审批，生产 profile 仍 `responder: none`） |

## 3. 覆盖率为什么只有一个值

`31233 / 34270 = 91.14%`。**只能用 CI 口径**：本机（Windows）报表会把没有执行行的文件按**物理行**计入分母（`packages/memory-store/src/types.ts` 精确 257 物理行，本机报表记为 `0/257`），分母虚高约 1900 行、行口径虚低约 5 个百分点。两个候选归因都已用对照实验排除：把 230 个 CRLF/mixed 文件按索引改成 LF 后复跑、以及改用 Node 22.19（与 CI 同版本）复跑，本机报表都仍是 31227/36169。差异在 Windows 下的 v8 行映射/文件枚举（无执行行文件是否计入分母），具体触发点尚未定位；两平台 covered 行数几乎一致（CI 31233 vs 本机 31227，差 6 行来自平台分支），差异全在分母。

因此 **本机时点值 86.33%（31227/36169）与更早的 86.32%（31191/36133）、86.06%（31093/36131）都已作废**，不要再引用——它们不是"覆盖率下降"，是分母算法在 Node 22.17 下失真。再往前 `85.84%` 有两个不同分母（29958/34898 与 30992/36106）、`85.83%`（29843/34771）与 `84.49%`（29163/34517）更早，同属本机口径，只作历史记录。
`docs/coverage-baseline.json` 是机器产物：重跑覆盖率高时先更新它，再跑
`npx tsx scripts/gen-architecture.ts` 重生成 `architecture.md` / `algorithms.md` / `security-design.md` 的事实块。
**不许手改那三份文档的生成块。**

## 4. 不在本表、也不许改的数

| 文件 | 原因 |
|---|---|
| `文档归档/**`（含已撤下的历史件：决策记录、开工前体检、交接件、施工台账与证据原件） | 归档稿，改数会让复核者失去时间线 |
