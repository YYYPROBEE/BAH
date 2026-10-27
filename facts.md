# BAH 事实表（演示材料的唯一数字来源）

> 更新：2026-10-27（C07 数字归一后复核）。任何 PPT / 视频 / 自评里的数字先查这里；
> 改代码后重跑对应命令再改本表。**不要把三行测试数相加成一个"总用例数"**。
> 数字的取值命令与原始输出见 `docs/facts-sources.md`；门禁 `verify-facts` 逐项比对，不一致即红。
> ⚠ 本表上一版停在 2026-10-24，被 W03–W17 甩在后面（门禁还写 27/27、工具还写 14 个、
> HP-2/3/4 还写"未施工"）。本版已逐条按命令输出重校。

## 1. 测试与门禁（三行口径）

| 命令 | 覆盖范围 | 实测 |
|---|---|---|
| `pnpm test` | 主仓 `packages/*/src/**/*.test.ts` + `scripts/**/*.test.ts`（不含 e2e / snapshot / eval / web） | **205 文件 / 2112 用例** |
| `pnpm eval:unit` | 评测包（不在根 vitest include 内） | **22 文件 / 158 用例** |
| `pnpm test:web` | `apps/web`（DOM / 投影 / 弹窗） | **7 文件 / 55 用例** |

其他口径：

| 命令 | 结果 | 说明 |
|---|---|---|
| `pnpm gate` | **36/36** | `scripts/run-gates.ts` 动态发现全部 `verify-*.ts`，任一失败退出码 1；**不需要** `BAH_ALLOW_NO_SNAPSHOT` |
| `pnpm typecheck` | 通过 | `tsc -b` host + client 两套配置 |
| `pnpm test:snapshot` | 6 文件 / 23 用例（23/23 绿） | 录制回放；`pnpm snapshot:record` 重录 |
| `pnpm check` | **十四步**总闸 | typecheck → lint → build → test → coverage → coverage:all → gate → eval:unit → eval:smoke → eval:baseline → e2e → snapshot → web → rag |
| `pnpm test:coverage:all` | **行口径 91.13%**（31197/34234）/ **包口径 15/16**（**CI/Ubuntu 口径**） | 两个口径必须一起说；未达标只有 `eval` 53.20%（`memory-store` 89.40% 已达标） |

评测平面（`pnpm eval`）：

| 指标 | 实测 |
|---|---|
| 场景 | 60 个（Q/T/P/S/D/K 六族），boot 8 次 |
| 任务成功率 / 越权拦截率 / 拒答正确率 | 49/49 · 5/5 · 6/6，平均 1.25 步 |
| 对抗集 | 45 例（分母 44，排除 1 例 `[unverified]` 来源），总拦截 41/44；注入 14/14、越权 15/15、幻觉 12/15 |

## 2. 工具：16 个（12 绿 / 2 黄 / 2 红）

| # | 工具 | 级别 | 职责 |
|---|---|---|---|
| 1 | `account_list` | green | 列出账户（尾号/类型/状态/余额） |
| 2 | `account_balance` | green | 查账户余额与可用余额 |
| 3 | `txn_query` | green | 按时间/分类/方向分页查流水 |
| 4 | `bill_analyze` | green | 月度/季度汇总、分类占比、环比、异常 |
| 5 | `bill_report` | green | 生成可读账单报告 |
| 6 | `analysis_calc` | green | 受限算术语言（无网络/文件/循环） |
| 7 | `transfer_preview` | green | 转账试算 + 风控预检 |
| 8 | `transfer_create` | **yellow** | 发起转账，必进审批；超限/新收款人升红 |
| 9 | `wealth_list` | green | 按风险/类型/期限筛理财 |
| 10 | `wealth_compare` | green | 2–4 个产品并列对比 |
| 11 | `wealth_purchase` | **red** | 购买理财：强验证 + 审批 |
| 12 | `verify_face` | green | 人脸挑战 |
| 13 | `verify_sms` | green | 短信挑战 |
| 14 | `verify_ushield` | green | U 盾挑战 |
| 15 | `card_report_lost` | **red** | 挂失银行卡（不可逆，必进审批 + 强验证） |
| 16 | `sub_cancel` | **yellow** | 取消自动扣款订阅（可逆） |

口径：

- 上限 28，当前 16（`docs/tool-catalog.md` 由 `pnpm tool-catalog` 生成，门禁逐字比对）。
- `verify_*` 虽为 green，但 `sideEffect: write`，不参与并行读批。
- 模型参数金额单位是**元**，核心与事件是**分**（字段带 `Cents`）。

## 3. 端口与入口

| 端口 | 用途 | 绑定 | 说明 |
|---|---|---|---|
| **7331** | Web UI / HTTP / SSE / 静态资源 | `127.0.0.1` | `pnpm web` / `pnpm demo:web`；端口占用**不自动换端口** |
| **7801** | RAG sidecar | `127.0.0.1` | `bank:knowledge mode:http`；`required: false`，不起也能跑主场景 |

静态根 `apps/web`：原生 ES 模块，无构建步骤。
`pnpm demo:web` 每次新建 `sessions/demo-<stamp>-<随机>/`，日志、Saga 库与审计链都在该目录；
`pnpm gate` 用 `.tmp-saga-wiring/` 的独立库，不写 `sessions/`。

## 4. 常用命令（四类）

| 目的 | 命令 |
|---|---|
| 起演示（读 `.env.local` 的 `BAH_MODEL_KEY`） | `pnpm demo:web`（打印本次会话目录） |
| 起演示（直接用当前环境变量，共享 `sessions/`） | `pnpm web` |
| 自检 | `pnpm typecheck && pnpm test && pnpm gate` |
| 审计已落盘的链 | `pnpm bah audit --dir <demo 打印的目录> [--no-signature] [--format json]` |

其他：

- `pnpm bah sentry unfreeze --by <operator>`：解冻断路器（只对运行中的 Web 宿主有效；headless 只能重启）。
- `pnpm bah --profile headless --prompt "..."`：无头跑一轮。

## 5. 模型与演示路径

| 项 | 值 |
|---|---|
| 主路径 | `provider: router`，`model: router-chat`：离线、确定性，读消息做意图路由（只认查余额 / 转账；认不出会追问） |
| 可替换模型 | `provider: deepseek` + `baseUrl: https://dashscope.aliyuncs.com/compatible-mode/v1` + `apiKeyEnv: BAH_MODEL_KEY`（`.env.local`，不入库）；切 `core:model` 与 `core:agent.loop.model` **两处**，手动切换，不是自动降级 |
| 知识问答 | Web 的 router **不规划**知识意图；用 `pnpm demo:rag`（headless）演示，sidecar 与宿主共用 `BAH_KNOWLEDGE_TOKEN`（无 token 拒启） |
| 审批 | 黄级 `transfer_create` → 票据 → Web 弹窗；红级另加强验证 |
| 会话作用域 | 单用户、单会话、单进程；无多租户；Web `/api/*` 有 60s/120 次每来源限流 |

## 6. 交付与安全口径（写材料时照抄）

- 审计链零签名状态是 **`unsigned`**（"没签过"≠"验签通过"）；CLI 按"审计未完成"退出码 2。
  只验链连续性与投影用 `--no-signature`（退出码 0），这不是完整验签。
- Web 鉴权是 **Bearer token 最小集**：`BAH_WEB_TOKEN`，未配置时每进程随机生成并注入 `index.html`；
  响应带 CSP / XFO / XCTO / Referrer-Policy / Permissions-Policy，`/api/*` 每来源 60s/120 次限流，
  **不是登录**；无 CORS（同源）。
- 供应链：Dependabot + `.github/workflows/security.yml`（npm audit 用官方源；pip-audit 先收集基线）。
- 银行账本是内存仿真，进程重启回种子；不宣称持久。
- 强验证渠道（短信/人脸/U 盾）语义位齐全，但全部是 mock，未接真实渠道。
- **已知未做清单以 `docs/security-design.md` §4 的 6 条为准**（每条写了为什么不做 + 影响面）：
  HP-2 RAG 响应信封签名 / 强验证接真实渠道 /
  对抗集 H-13~H-15 幻觉族召回缺口 / plan 内写工具的补偿 / plan 动态 args 跨 `resume` /
  `incident` 状态的真实触发源。
  ⚠ 旧版本这里写的"HP-2 / HP-3（HALT 解除）/ HP-4 未施工"**已过期**：
  HP-2 对应的知识库双层签名（W06）、HP-3 对应的 HALT 闭环（W07）、HP-4 对应的工具出参契约（W03）都已落地。
- 断言核验门（W05）当前口径：`verified` 原文发 / `needs-evidence` 加`【未核实】`前缀 /
  `reject` 换拒答文本（`reasonCode=assertion-unverified`）。对抗集幻觉族 12/15，3 例为已知召回缺口。
