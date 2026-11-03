# BAH 事实表（演示材料的唯一数字来源）

> 更新：2026-11-01（AA 参与人状态机 + 到期收口，新增 `aa/participant-updated` 一个事件键，ADR-0017；工具 30 个、事件键 **38** 个。门禁 53；用例数按当前工作树实测，见 `docs/facts-sources.md`）。演示材料里的数字先查这里；
> 改代码后重跑对应命令再改本表。**不要把三行测试数相加成一个"总用例数"**。
> 数字的取值命令与原始输出见 `docs/facts-sources.md`；门禁 `verify-facts` 逐项比对，不一致即红。

## 1. 测试与门禁（三行口径）

| 命令 | 覆盖范围 | 实测 |
|---|---|---|
| `pnpm test` | 主仓 `packages/*/src/**/*.test.ts` + `scripts/**/*.test.ts` + `apps/desktop/src/**/*.test.ts` + `apps/im-gateway/{src,test}/**/*.test.ts`（不含 e2e / snapshot / eval / web） | **455 文件 / 5283 用例**（2026-11-03 全量实测（清理线）：较 446/5148 增 9 个用例文件（远端清理线补的 5 个覆盖率文件 + 本批 4 个），另有路由兜底、核心守卫等用例补齐。**如实登记**：全量跑时 `apps/im-gateway/test/supervisor.test.ts` 有 1 例时序偶发失败，单文件重跑 17/17 绿，与用例数口径无关） |
| `pnpm eval:unit` | 评测包（不在根 vitest include 内） | **22 文件 / 158 用例** |
| `pnpm test:web` | `apps/web`（DOM / 投影 / 弹窗 / 移动壳交互面） | **49 文件 / 610 用例**（全绿；2026-11-03 实测（清理线）：较 47/550 新增 `views/history.test.js` 27 例、`mobile/history-sheet.test.js` 14 例与批内 18 例） |

其他口径：

| 命令 | 结果 | 说明 |
|---|---|---|
| `pnpm gate` | **53/53** 项已发现（本次 **53 全绿**） | `scripts/run-gates.ts` 动态发现全部 `verify-*.ts`，任一失败退出码 1 |
| `pnpm typecheck` | 通过 | `tsc -b` host + client 两套配置 |
| `pnpm test:snapshot` | 13 文件 / 60 用例（**60 全绿**） | 新增 `birthday-reminder`（事实库驱动：3 天窗口 / 同日幂等 / 生日当天不重复 / 通知帧回放 / 负控 6 例）；`plan` / `cross-scene` / `subscription-reminder` / `birthday-reminder` 用夹具 overlay 显式放行审批（ADR-0010 后 profile 是 `responder: none`），重录只写快照产物，未改生产 profile |
| `pnpm check` | **十四步**总闸 | typecheck → lint → build → test → coverage → coverage:all → gate → eval:unit → eval:smoke → eval:baseline → e2e → snapshot → web → rag |
| `pnpm test:coverage:all` | **行口径 97.43%**（60053/61636）/ **包口径 18/18** | 两个口径必须一起说；18 个包全部 ≥80%（最低 `saga` 90.34%），见台账注记 |
评测平面（`pnpm eval`）：

| 指标 | 实测 |
|---|---|
| 场景 | 91 个（Q14/T16/P11/S8/D15/K10/U17），boot 9 次 |
| 任务成功率 / 越权拦截率 / 拒答正确率 | 78/78 · 6/6 · 7/7，平均 1.44 步 |
| 对抗集 | 45 例（分母 44，排除 1 例 `[unverified]` 来源），总拦截 42/44；注入 14/14、越权 15/15、幻觉 13/15 |

## 2. 工具：30 个（14 绿 / 10 黄 / 6 红）

> 口径注脚：`goal_set` / `todo_write` 与 `intent_resolve` / `prompt_ask` 是
> **runtime / interaction 内置绿级工具**，不在"银行工具目录 30 个"里——工具目录由
> `pnpm tool-catalog` 生成、门禁逐字比对，本套单一个银行工具都没加（D9）。

| # | 工具 | 级别 | 职责 |
|---|---|---|---|
| 1 | `account_list` | green | 列出账户与卡片（账户尾号/类型/余额；卡 ID/尾号/状态/限额；信用产品另有额度/已用/可用） |
| 2 | `account_balance` | green | 查账户余额与可用余额 |
| 3 | `txn_query` | green | 按时间/分类/方向分页查流水 |
| 4 | `bill_analyze` | green | 月度/季度/年度汇总、分类占比、环比、异常 |
| 5 | `bill_report` | green | 生成可读账单报告 |
| 6 | `analysis_calc` | green | 受限算术语言（无网络/文件/循环） |
| 7 | `transfer_preview` | green | 转账试算 + 风控预检 |
| 8 | `transfer_create` | **yellow** | 发起转账，必进审批；超限/新收款人升红 |
| 9 | `aa_create` | **yellow** | AA 拆分收款请求（均分/自定义份额；`decline` 拒绝 / `close` 提前结束；不伪造到账） |
| 10 | `wealth_list` | green | 按风险/类型/期限筛理财 |
| 11 | `wealth_compare` | green | 2–4 个产品并列对比 |
| 12 | `wealth_purchase` | **red** | 购买理财：适当性闸门 + 强验证 + 审批 |
| 13 | `risk_assess` | **yellow**（`action=questions` 只读豁免） | 服务端问卷：取卷 / 提交用户逐题作答；卷 15 分钟有效、一次性核销，题干与分值不进模型 |
| 14 | `wealth_positions` | green | 持仓/成本/市值/盈亏 |
| 15 | `wealth_redeem` | **red** | 赎回理财：强验证 + 审批 |
| 16 | `verify_face` | green | 人脸挑战 |
| 17 | `verify_sms` | green | 短信挑战 |
| 18 | `verify_ushield` | green | U 盾挑战 |
| 19 | `card_report_lost` | **red** | 挂失银行卡（不可逆，必进审批 + 强验证） |
| 20 | `fund_lock` | **yellow**（`action=status` 只读豁免） | 资金锁定/释放（活期 ↔ 本人锁定户；`status` 只读不签票） |
| 21 | `sub_cancel` | **yellow** | 取消自动扣款订阅（可逆；合约期硬拦，支持到期即断） |
| 22 | `sub_list` | green | 订阅清单 + 周期扣款检测（三分法/涨价/断供核验；推断不落账） |
| 23 | `sub_watch` | **yellow** | 订阅提醒/标注（写事实账本字段，绿档会豁免四道闸所以归黄） |
| 24 | `sub_authorize` | **yellow** | 关闭商户代扣协议（只关不开，影响该商户全部订阅） |
| 25 | `card_freeze` | **yellow** | 冻结银行卡（可逆止损） |
| 26 | `card_unfreeze` | **red** | 解冻银行卡（强验证 + 审批） |
| 27 | `card_apply` | **yellow** | 申请新卡（虚拟卡缺省）；`kind='credit'` 时给授信额度（信用产品，ADR-0015） |
| 28 | `card_limit_set` | **red** | 调整日/月限额或**授信额度**（降额不得低于已用；强验证 + 审批） |
| 29 | `card_restriction` | **yellow** | 设置/解除交易限制（线上/境外/品类） |
| 30 | `password_change` | **red**（`action=status` 只读豁免） | 交易密码交办：签一次性交接票据送安全页（ADR-0014）；参数里**没有**密码字段 |

口径：

- 上限 31（2026-11-01 由 30 扩容，同批落地 `password_change`），当前 30（`docs/tool-catalog.md` 由 `pnpm tool-catalog` 生成，门禁逐字比对）。
- `verify_*` 虽为 green，但 `sideEffect: write`，不参与并行读批。
- 模型参数金额单位是**元**，核心与事件是**分**（字段带 `Cents`）。

## 3. 端口与入口

| 端口 | 用途 | 绑定 | 说明 |
|---|---|---|---|
| **7331** | Web UI / HTTP / SSE / 静态资源 | `127.0.0.1` | `pnpm web` / `pnpm demo:web`；端口占用**不自动换端口** |
| **7801** | RAG sidecar | `127.0.0.1` | `bank:knowledge mode:http`；`required: false`，不起也能跑主场景 |
| **7551** | 移动 H5 UI / HTTP / SSE | `127.0.0.1` | `pnpm bah --profile mobile`；与 7331 同族，端口占用**不自动换端口** |
| **0（OS 分配）** | 桌面壳私有 host | `127.0.0.1` | `profiles/desktop` 写 `port: 0`；每次启动端口都不同，主进程从 `DESKTOP_SERVER` 读实际值（**无固定端口**） |
| **7552** | IM 子进程 HTTP / SSE（仅本机） | `127.0.0.1` | `pnpm bah --profile im`；IM 网关逐用户拉起的最小宿主页，**公网不可达** |
| **8080** | IM 网关公网入口（HTTP 回调） | `0.0.0.0` | `pnpm im:gateway`（`apps/im-gateway`）；反代后可改 `127.0.0.1`；端口占用**不自动换端口** |

静态根 `apps/web`：原生 ES 模块，无构建步骤。

| 入口 | 渠道 | 说明 |
|---|---|---|
| `/` → `index.html` | `channel:web`（7331） | 桌面壳，`entries: [index.html]` |
| `/` → `m.html` | `channel:mobile`（7551） | 移动壳，`entries: [m.html, index.html]`；`m.html` 也是 token 入口（注入 Bearer + CSRF cookie + `no-store`），其它 HTML 一律不注入 |
| `/` → `index.html` | `channel:desktop`（0，OS 分配） | Electron 窗加载同一份桌面壳，`entries: [index.html]`；不认 `m.html`（名单外不注入 token） |
| `/` → `m.html` | `channel:im`（7552） | IM 子进程**不提供 Web UI**：该入口只在本机 loopback 可达，仅供排障与 CSRF cookie 握手；`entries: [m.html]` |
| `/im/:platform/:accountKey` | `apps/im-gateway`（8080） | 公网回调入口：`GET` 握手 / `POST` 消息；未知平台/账号 404；网关不反代子进程 `/api/*` |

「前端不需要先 build」对两个壳同等成立：`m.html` 只引三份外链 css 与一个原生 ESM 入口。
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
- Web 鉴权是 **Bearer token 最小集**：`BAH_WEB_TOKEN`，未配置时每进程随机生成并注入 `channel:{web,mobile}` 的 `entries` 白名单里的 HTML（默认 `index.html`）——
  **非白名单 HTML 不注入**（按扩展名注入会把静态根下任何 HTML 变成 token 泄漏面），移动壳与桌面壳共用同一份静态处理器；
  响应带 CSP / XFO / XCTO / Referrer-Policy / Permissions-Policy，`/api/*` 每来源 60s/120 次限流，
  **不是登录**；无 CORS（同源）。
- 供应链：Dependabot + `.github/workflows/security.yml`（npm audit 用官方源；pip-audit 先收集基线）。
- 银行账本是内存仿真，进程重启回种子；不宣称持久。
- 强验证渠道（短信/人脸/U 盾）语义位齐全，但全部是 mock，未接真实渠道。
- **已知未做清单以 `docs/security-design.md` §4 的 6 条为准**（每条写了为什么不做 + 影响面）：
  RAG 响应信封签名 / 强验证接真实渠道 /
  对抗集 H-14~H-15 幻觉族召回缺口 / plan 内写工具的补偿 / plan 动态 args 跨 `resume` /
  `incident` 状态的真实触发源。
  知识库双层签名、HALT 闭环、工具出参契约都已落地，不在这份缺口清单里。
- 断言核验门当前口径：`verified` 原文发 / `needs-evidence` 加`【未核实】`前缀 /
  `reject` 换拒答文本（`reasonCode=assertion-unverified`；收益承诺类为 `prohibited-guarantee`）。对抗集幻觉族 13/15，2 例为已知召回缺口。
- 意图平面口径：**选择题式追问 ≤2 次**，第 3 次降级为开放式提问并标 `askExhausted`（不计为追问）；
  复现类意图（`vague`）**恒 `requiresPreview=true`**，参数必须先经 `transfer_preview` 确认；
  隐含意图（`implicit`）**恒 `propose`**，绝不直接执行。这三条都是代码里的硬约束，不是话术。
