# BAH 事实表（演示材料的唯一数字来源）

> 更新：2026-10-23（D6 复审实测；23:05 复核 `pnpm test` = 164 文件 / 1561 用例、`test:web` = 6 文件 / 52 用例）。任何 PPT / 视频 / 自评里的数字先查这里；
> 改代码后重跑对应命令再改本表。**不要把三行测试数相加成一个"总用例数"**。

## 1. 测试与门禁（三行口径）

| 命令 | 覆盖范围 | 实测 |
|---|---|---|
| `pnpm test` | 主仓 `packages/*/src/**/*.test.ts`（不含 e2e / snapshot / eval / web） | **164 文件 / 1561 用例** |
| `pnpm -F @bah/eval test` | 评测包（不在根 vitest include 内） | **14 文件 / 133 用例** |
| `pnpm test:web` | `apps/web`（DOM / 投影 / 弹窗） | **6 文件 / 52 用例** |

其他口径：

| 命令 | 结果 | 说明 |
|---|---|---|
| `pnpm gate` | **27/27** | `scripts/run-gates.ts` 动态发现全部 `verify-*.ts`，任一失败退出码 1 |
| `pnpm typecheck` | 通过 | `tsc -b` host + client 两套配置 |
| `pnpm test:snapshot` | 4 文件 / 14 用例 | 录制回放；`pnpm snapshot:record` 重录 |
| `pnpm check` | 十步总闸 | typecheck → lint → build → test → coverage → gate → e2e → snapshot → web → rag |

## 2. 工具：14 个（12 绿 / 1 黄 / 1 红）

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

口径：

- 上限 28，当前 14（`docs/tool-catalog.md` 由 `pnpm tool-catalog` 生成，门禁逐字比对）。
- `verify_*` 虽为 green，但 `sideEffect: write`，不参与并行读批。
- 模型参数金额单位是**元**，核心与事件是**分**（字段带 `Cents`）。

## 3. 端口与入口

| 端口 | 用途 | 绑定 | 说明 |
|---|---|---|---|
| **7331** | Web UI / HTTP / SSE / 静态资源 | `127.0.0.1` | `pnpm web` / `pnpm demo:web`；端口占用**不自动换端口** |
| **7801** | RAG sidecar | `127.0.0.1` | `bank:knowledge mode:http`；`required: false`，不起也能跑主场景 |

静态根 `apps/web`：原生 ES 模块，无构建步骤。

## 4. 常用命令（四类）

| 目的 | 命令 |
|---|---|
| 起演示（读 `.env.local` 的 `BAH_MODEL_KEY`） | `pnpm demo:web` |
| 起演示（直接用当前环境变量） | `pnpm web` |
| 自检 | `pnpm typecheck && pnpm test && pnpm gate` |
| 审计已落盘的链 | `pnpm bah audit --dir <path> [--format json]` |

其他：

- `pnpm bah sentry unfreeze --by <operator>`：解冻断路器（只对运行中的 Web 宿主有效；headless 只能重启）。
- `pnpm bah --profile headless --prompt "..."`：无头跑一轮。

## 5. 模型与演示路径

| 项 | 值 |
|---|---|
| 主路径 | `provider: deepseek`，`model: deepseek-v4.1-flash-1017`，`baseUrl: https://dashscope.aliyuncs.com/compatible-mode/v1` |
| 密钥 | `apiKeyEnv: BAH_MODEL_KEY`（`.env.local`，被 `.gitignore` 挡住，不入库） |
| 断网兜底 | `provider: router`（`router-chat`）：读消息做意图路由，不读固定脚本；**手动改 profile，不是自动降级** |
| 审批 | 黄级 `transfer_create` → 票据 → Web 弹窗；红级另加强验证 |
| 会话作用域 | 单用户、单会话、单进程；无多租户、无速率限制 |

## 6. 交付与安全口径（写材料时照抄）

- 审计链零签名状态是 **`unsigned`**（"没签过"≠"验签通过"）；CLI 按"审计未完成"退出码 2。
- Web 鉴权是 **Bearer token 最小集**：`BAH_WEB_TOKEN`，未配置时每进程随机生成并注入 `index.html`；
  无 Origin/CSP/安全响应头，**不是登录**。
- 银行账本是内存仿真，进程重启回种子；不宣称持久。
- 强验证渠道（短信/人脸/U 盾）语义位齐全，但全部是 mock，未接真实渠道。
- HP-2（RAG 签名 / TS 验签门）、HP-3（HALT 解除）、HP-4（出参契约）**未施工**；
  自评里按"未施工"登记，不说成"已支持"。
