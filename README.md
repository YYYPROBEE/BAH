# BAH · 银行智能体

> 仓库：https://github.com/YYYPROBEE/bah
> 许可：源码公开可见，但不是开源许可；授权范围见 [LICENSE](LICENSE)

**一个把"模型能做什么"关进可审计边界里的银行智能体演示系统。**

模型只负责理解和表达；能不能执行、执行到什么程度、出事后怎么解释，全部由确定性代码决定。
30 个银行工具、七段工具管线、三级权限、一次性票据、四接缝安全平面、append-only 会话日志与
SHA-256 审计链，构成一条可回放、可核验、可解释的业务链。

> 演示材料里的数字统一取自 [facts.md](facts.md)；架构细节见 [docs/pipeline.md](docs/pipeline.md)、
> [docs/sentry.md](docs/sentry.md)、[docs/audit.md](docs/audit.md)。

---

## 1. 快速开始

环境：Node.js `^22.19 || >=24`，pnpm 10。

```bash
pnpm install
```

| 目的 | 命令 | 说明 |
|---|---|---|
| **起演示** | `pnpm demo:web` | 主路径为**离线 router**（不读密钥、不依赖外网），每次新建独立会话目录，打开 `http://127.0.0.1:7331` |
| **容器演示** | `docker build -t bah:local . && docker run --rm -p 7331:7331 bah:local` | 单容器 Web，默认离线 router（不需要密钥）；RAG sidecar 不在镜像内，知识工具降级为 `knowledge-unavailable` |
| **移动 H5 演示** | `pnpm bah --profile mobile` | 第二个壳（`staticRoot` 同为 `apps/web`），打开 `http://127.0.0.1:7551`；与 7331 共用同一份 `createHttpChannel`（路由 / 闸序 / 安全头 / 审批端点） |
| **桌面端演示** | `pnpm build && pnpm desktop:dev` | Electron 窗口内嵌私有 host（`port:0`，只绑 `127.0.0.1`），加载同一份 `apps/web`；断网可用。打包见 `pnpm desktop:pack`，说明见 [docs/desktop.md](docs/desktop.md) |
| **自检** | `pnpm typecheck && pnpm test` | 类型 + 主仓 444 文件 / 5092 用例 |
| **门禁** | `pnpm gate` | 54 项静态与契约检查，任一红即失败 |
| **审计** | `pnpm bah audit --dir <path>` | 离线复验会话日志 + 审计链（`--format json` 出机器可读） |

主演示**不需要密钥**：`profiles/web/patch.yml` 默认 `provider: router`（读消息做意图路由，
覆盖六场景演示语法：余额/转账/定时转账/AA/理财/账单/卡片/订阅/资金锁定/商户订购/生日计划；
**不是自然语言理解**，认不出会追问，且绝不替用户猜金额、收款人或时点）。从 2026-11-01 起
web 主演示已装配 `plan:dag` / `fact:store` / `plan:scheduler` / `bank:merchant`——场景 6 的
"生日计划 + 到点唤醒 + 商户腿"在主演示里是真跑通的，不再是预演文案。DeepSeek 是**可替换 provider 的证据**：
把 `core:model` 与 `core:agent.loop.model` 两处**成对**换成 profile 注释里的 DeepSeek 块，
并在 `.env.local`（不入库）写：

```text
BAH_MODEL_KEY=<你的模型密钥>
```

这是**手动切换**，不是自动降级；只在需要 Web 内真实模型回答时使用。

知识检索：知识问答不在 router 的意图范围内，用 `pnpm demo:rag`（一条命令起停 sidecar，
并把同一 token 注入 sidecar 与宿主）。需要手工起 sidecar 时用 `pnpm rag:dev`（端口 7801），
它会在未配置 token 时生成一次性演示 token 并打印；宿主必须用同一 `BAH_KNOWLEDGE_TOKEN`。
sidecar 认证是 fail-loud（无 token 拒启），工具在缺 token 时按 `knowledge-denied` fail-closed。

### 移动 H5 的能力边界（如实口径）

**语音输入**：语音输入通过设备系统输入法完成，本页面**不申请麦克风权限、不采集音频、不做录音上传**；`Permissions-Policy` 保持 `camera=(), microphone=(), geolocation=()` 全关。
真机上各输入法的听写质量不由本工程控制，**不承诺识别准确率**；桌面 DevTools 的移动模拟**没有 IME 语音**，故演示与 CI 一律用输入区上方的**快捷短语 chips**（离线、确定性）。

**滑动确认**：

1. 手势确认**不等于**强验证；红级操作仍需 U 盾/人脸/短信挑战（走 `/api/verify/:ticketId`）。
2. 用脚本直接 `POST /api/approval/:ticketId` 而不滑动，**服务端会接受**——滑动是 UI 约束，不是凭证。
3. 因此"手势"不得出现在任何安全评审的"控制项"里，只能出现在"人机工程/防误触"里。

**同一条纪律也适用于强验证**（2026-10-29 实测补充）：`packages/channels/src/http-adapter.ts` 的 `decide()`
只校验票据归属、结论合法性与拒绝理由，**不校验 `verify()` 是否已通过**。所以"红级必须先强验证"
在桌面与移动两个壳里都是**界面层约束**，不是服务端强制；对外材料不得把它写成防线。

---

## 2. 架构

```mermaid
flowchart LR
  U[用户] --> W[Web 渠道<br/>HTTP + SSE + 审批弹窗]
  U --> C[CLI / headless]
  W --> H[宿主组合根<br/>profile + plugin rows]
  C --> H
  H --> A[Agent 主循环<br/>turn / step / next-step]
  A --> L[模型适配器<br/>DeepSeek / router / mock]
  A --> P[七段工具管线]
  P --> G[治理判决<br/>规则 / 预算 / 断路器 / 三级权限]
  G --> T[票据 + 审批<br/>一次性核销]
  T --> B[银行核心 + 18 工具<br/>内存账本]
  P --> SG[Saga 补偿 / 幂等]
  P --> SB[沙箱执行<br/>三档 + worker]
  A --> J[(append-only 会话日志)]
  J --> AU[审计哈希链<br/>SHA-256 + Merkle 根]
  J --> PR[Web 投影器<br/>纯函数]
  PR --> W
  S[sentry 安全平面] -. 四接缝 .-> A
  S -. post-execute / turn-stopping .-> P
```

### 2.1 分层与包职责

| 层 | 包 | 职责 |
|---|---|---|
| 内核 | `packages/core` | Context / 事件（emit、waterfall、serial、parallel）/ 服务注册 / 插件装配 |
| 组合根 | `packages/host` | profile 解析、boot、插件行（渠道、模型、工具、sentry 的接线） |
| 主循环 | `packages/runtime` | turn/step、提示词装配、七段工具管线、会话存储、压缩、恢复 |
| 模型 | `packages/llm` | DeepSeek（OpenAI 兼容协议）、离线意图路由、固定脚本 mock |
| 银行 | `packages/bank` | 内存账本、30 个工具、三级权限升级、票据桥接、强验证状态机 |
| 策略 | `packages/policy` | 决策表 DSL + 编译器 + 内容寻址；规则在 `policies/**`，`tier.ts` 保留为 legacy oracle |
| 交互 | `packages/interaction` | 审批仲裁器 + 票据账本（五绑定、一次性核销、过期） |
| 安全 | `packages/safety` | sentry（检测 / 控制 / 票据观测 / 审计 / 幻觉防护 / 断路器）+ 沙箱 |
| 可靠性 | `packages/saga` | 多步配方、补偿、幂等键、审计锚点 |
| 数据 | `packages/persistence` | JSONL 会话、投影、SHA-256 审计链、签名覆盖 |
| 知识 | `packages/knowledge` | RAG 端口、ACL / 时效窗 / 引用校验、知识工具 |
| 渠道 | `packages/channels` | 事件 → Web 帧的纯投影（对话 / 工具卡 / 审批 / DAG / 审计） |
| 前端 | `apps/web` | 原生 ES 模块，无框架、无构建 |
| 命令行 | `packages/cli` | profile bundle、`run` / `audit` / `sentry unfreeze` |
| 评测 | `packages/eval` | M0 判定器、证据与轨迹录制（独立测试配置） |
| 其他 | `packages/memory-store`、`packages/util`、`packages/test-support` | 跨会话记忆（`bah:memory-store` 已接线：turn 边界写入、本轮第一步召回、提示词段注入；profile 显式开启）、零依赖原语、测试夹具 |

### 2.2 一次工具调用的七段

1. `tool/call` 落账；
2. `presentCall(args)` 生成"即将做什么"的卡片（纯函数）；
3. `tools/pre-execute`（**唯一阻断点**）：危险规则 → PII → 预算 → 断路器 → 三级权限；
4. 需要确认时签一次性票据 → `approval/request` → 人点批准/拒绝；
5. `tools/execute` 环绕执行（沙箱 / 超时）；
6. `projectContent` → `tools/post-execute`（脱敏、数值对账、纠正）；
7. 归一化 → `tools/result` → `tool/result` 落账 → 追加纠正上下文 → 卡片。

顺序是冻结契约，不是实现细节；改顺序必须同步文档并重录全部快照。

---

## 3. 算法

### 3.1 三级权限与升级（取高不取低）

- 工具声明下限：`green` 直接执行、`yellow` 必须确认、`red` 强验证 + 确认；
- 转账的动态升级：日累计超限 → 红；新收款人 → 红；组合风险超阈（同 turn 风险调用过多）→ 非绿一律 `ask`；
- **规则文件化**：默认判定来自 `policies/bank-tier/1.0.0`（决策表 + 内容寻址），与 `tier.ts`
  legacy 在 960 组输入域上（480 组已绑定逐字段等价 + 480 组未绑定只验 `no-identity` 边界）；
  `bank:tools.policy.engine: legacy` 是整体回退开关。
  作者/运维手册见 [docs/policy.md](docs/policy.md)；
- 日限额取 `min(卡片限额, Config.dailyTransferLimit)`：**只调 Config 一处，判决与预演展示一起动**；
- 升级只升不降：同一 turn 内已判红，后续不会因为参数变化降回黄。

### 3.2 sentry：检测、控制、对账

- 入口：13 条确定性规则（破坏性命令 / 提权 / 网络外联 / SQL / 越权转账等）+ 分数阈值；
  检测只记分与落审计，**永不直接阻断**；
- 执行前：规则、预算、断路器、只绿降级共同决定 `deny`；
- 结果后：数值对账（声明金额 vs 工具权威金额）不一致 → `block` + 纠正文本；
- 收尾：S-1 行动断言对账——"已完成 / 已转账 / 已核销 / 办理成功 / 已到账"必须与本 turn
  成功的工具结局相符；不符先 `nudge`，同 turn 再犯则判停；
- **fail-closed**：sentry 自己的判决件（post-execute 与 turn-stopping）抛错时，
  一律升级为 block / stop，绝不因为"核验坏了"而放行。

### 3.3 票据：五绑定、一次性、不可预测

票据绑定 `sessionId / tool / 参数指纹 / 金额（分）/ 到期时刻`；ID 是随机 UUID，不由调用 ID 派生。
批准一次性核销；拒绝、过期、无人应答都落 `blocked`。审批 URL 里读到上一张票，猜不出下一张。

W12 起另有**执行 lease**（`leaseId` / `ticketId` / `expiresAt`）：签发时由宿主注入，
`lease.expiresAt <= 票据 TTL`；过期即作废、不重签，核销点直接拒绝（`ticket-expired`）。
`TicketLease` 是独立类型，不改动既有两份 `TicketRef`。

### 3.4 Saga、沙箱、审计链

- **Saga**：配方化多步执行（演示主场景是"预检 → 执行"两段 DAG），每步带幂等键与状态机；
  失败经窄端口自动冲正——`MockBankCore.reverse(txnId)` 落"原交易 + 冲正流水"两条，幂等键 = `txnId`，
  当日额度按净转出回退；补偿成功 → `COMPENSATED`，失败 → `COMPENSATION_DLQ`（可人工 `MANUALLY_CLOSED`）。
  **Mock 提供幂等冲正语义，生产必须接银行核心的冲正/退款接口**；
- **沙箱**：`query-only` / `compute-bounded` / `none` 三档；模型生成的代码只能进隔离档，
  一次性 worker + 硬时限 + 堆上限 + 空能力白名单；会话只能收紧档位，放宽必须有人签过的一次性批准；
- **审计链**：`recordHash = sha256(prevHash | canonicalJson(record))`，确定性 canonical JSON；
  支持 Merkle 根与按类型的签名覆盖。**零签名链的报告状态是 `unsigned`，不是 `verified`**。

### 3.5 上下文与知识

- 压缩只折叠**已完整结束**的 turn，当前 turn 永不折叠；金融字段（金额 / 收款人 / 票据）保留结构；
- RAG 检索带 ACL、时效窗、引用与数值校验；sidecar 缺席时知识工具 fail-closed。
  知识**条目级验签已落地**（W06：sha256 + HMAC + 引用绑定，任一条失败整条降级拒答）；
  **未做的是 RAG 响应的信封签名**（HP-2，防"服务端整体被替换"，取舍与影响见
  `docs/security-design.md` §4 第 1 条）。

---

## 4. 安全

| 机制 | 落点 | 说明 |
|---|---|---|
| 默认拒绝 | 审批 / 强验证 | 无人应答 = `unavailable` = 拒绝；绝不默认放行 |
| fail-closed | sentry 判决件 | 核验异常 → block / stop，错误详情只进审计 |
| PII 脱敏 | 事件与审批帧 | 收款人姓名令牌化（`王**`）、手机号前 3 后 4；业务侧用令牌还原真名 |
| 票据安全 | `packages/interaction` | 五绑定、随机 UUID、一次性核销、过期即拒绝 |
| 沙箱 | `packages/safety` | 模型代码禁入 `none` 档；worker 硬杀；能力白名单恒空；逻辑隔离，不是 OS/容器隔离 |
| Web 凭证 | `packages/host` | 三种模式：`none`（无凭证）/ `static`（`svc:web` 客户 + `svc:operator` 坐席两把 token）/ `password`（scrypt + HttpOnly 会话 + 撤销）；写请求另需同源 Origin 或 CSRF double-submit |
| 角色与路由 | `packages/host` | 26 条路由 × 17 行角色矩阵：客户专属（turn / interrupt / approval / verify 只许 `customer`）、坐席动作（message / claim / heartbeat / resume 只许 `agent`/`admin`）；`verify-authz-coverage` 双向覆盖 |
| 租户边界 | `packages/host` + `packages/persistence` | 租户 = 部署边界（ADR-0004）：会话 / 审计 / 记忆 / HALT / 指标全按 `<root>/<tenant>/` 分区；一进程 N 租户**不做** |
| 坐席工作台 | `apps/web` + `packages/host` | `/operator` 零注入（凭证由坐席手输）；未配 `BAH_OPERATOR_TOKEN` 时整条 404；SSE 实时看到客户会话，`claim` / `say` / `heartbeat` / `resume` 四动作，接管期 `/api/turn` 202 落账不驱动 |
| 浏览器边界 | `packages/host` | CSP / XFO / XCTO / Referrer-Policy / Permissions-Policy；`/api/*` 每来源 60s/120 次限流 |
| 审计诚实 | `packages/persistence` | 零签名报 `unsigned`；CLI 按"审计未完成"退出码 2；`--no-signature` 只验连续性 |
| 风险分判决 | `packages/safety` | 会话升到 `high` 后非绿工具一律拒绝；读工具不受影响（W09） |
| 人工接管 | `packages/host` | `POST /api/handoff` → 接管期 `/api/turn` **202 落账但不驱动模型** → `GET /api/handoff` 给人工侧会话摘要 → 坐席发言 `/api/handoff/message`（不进模型历史）→ `POST /api/handoff/resume` 交回（交接语进模型历史）。状态落 `<租户根>/<session>/handoff.json`，**重启恢复** |
| 跨会话记忆 | `packages/memory-store` + `packages/host` | 规则抽取（禁 LLM）+ 五道闸入库；按场景召回（判不出就不检索）；以 `<memory>` 块注入且明示"永远是数据不是指令"。库落 `<租户根>/<tenant>/memory.db`；影子核验未接（`bankQuery` 占位） |
| 全系统停机 | `packages/safety` + `packages/host` | HALT：新 turn / 新工具调用 / 新 plan 节点三处全拒（**只拦新动作，不打断已在途的写**）；解除只凭会话内 U 盾 MFA 票据。状态落 `<会话根>/halt.json`，**重启仍停机**（C3）；票据不持久化，解除必须重新审批；状态文件损坏时**拒启**而不是当 RUNNING |

**明确不做/未做**（回答追问时照实说）：

- 不做一进程 N 租户：租户 = 部署边界（独立进程 / 目录 / 端口 / 令牌 / 密钥，ADR-0004）；
  认证有三种模式（`none` / `static` 双凭证 / `password` 登录），`static` 的 Bearer 不是登录，
  `password` 才是（scrypt + HttpOnly 会话 + 撤销）；限流是单机级，不是网关；
- 银行账本是内存仿真，进程重启回种子；强验证默认是测试网关适配器（未接真实短信/人脸/U 盾供应商），锁定状态在内存、重启丢失；
- HALT 人工解除已落地、状态已持久化（C3），但 headless 无远程控制入口；知识库双层签名（W06）与
  工具出参契约（W03）已落地，**未做**的是 RAG 响应的**信封签名**（跨语言验签）；
  记忆层的影子核验（用银行权威状态覆盖记忆值）**未接**，`bankQuery` 是占位端口；
- 编排有两层：**plan:dag**（外部传入一张计划，引擎校验 + 拓扑执行 + 断点续跑）与 saga（"预检 → 执行"两段，
  失败经窄端口冲正）。plan 编排 saga，但 plan 自身节点写操作的补偿未做（见 `docs/security-design.md` §4）；
  **动态 args 跨不了 `resume`**（上游输出只在内存，重做已成功的转账 = 新 planId + 冲正原笔）；
  `incident` 状态**没有真实触发源**（全内存 mock，Web DAG 视图按 `tool/call` 派生，不区分 incident 与 failed）；
- 对抗集幻觉族 15 例中 **H-14 / H-15 共 2 条未降级**（期望 `degrade` 实际 `allowed`，
  rule-gap：断言抽取未覆盖这两类表述，详见 `docs/security-design.md` §4 第 3 条；H-13 已由收益承诺禁词规则收口）；
- 覆盖率有两个包未到 80%：`memory-store` 72.71%、`eval` 40.73%（eval 主体是评测 harness）。
  行口径 86.06% **仅覆盖 `packages/*/src`**，不是物理全仓口径，引用时必须带包口径 14/16 一起说；
- 卡片挂失已实现（`card_report_lost`，红档不可逆、必进审批 + 强验证）；**解挂与密码修改未实现**；
- 注入 / 越权检测在演示与压测 profile 下**直接阻断**（对抗集注入族 14 例期望 `block` 全部通过）；
  生产 profile 默认关掉跨场景规则（`rules.crossScenario`），需按真实语料开启；

---

## 5. 30 个工具与权限

| 级别 | 工具 | 说明 |
|---|---|---|
| green | `account_list` `account_balance` `txn_query` `bill_analyze` `bill_report` `analysis_calc` | 只读查询与受限计算，自动执行 |
| green | `transfer_preview` | 转账试算 + 风控预检，不扣款 |
| **yellow** | `transfer_create` | 发起转账；必进审批，超限/新收款人升红 |
| green | `wealth_list` `wealth_compare` | 理财查询与对比（必带风险提示） |
| **red** | `wealth_purchase` | 购买理财：强验证 + 审批 |
| **red** | `card_report_lost` | 挂失银行卡：不可逆，必进审批 + 强验证 |
| **yellow** | `card_freeze` | 冻结银行卡：可逆止损，一次确认 |
| **red** | `card_unfreeze` | 解冻银行卡：恢复支付能力，强验证 + 审批 |
| **yellow** | `sub_cancel` | 取消自动扣款订阅：可逆 |
| green | `verify_face` `verify_sms` `verify_ushield` | 强验证挑战（`sideEffect: write`，不参与并行读批） |

完整参数、落账事件与生成规则见 [docs/tool-catalog.md](docs/tool-catalog.md)（由 `pnpm tool-catalog` 生成，门禁逐字比对）。

---

## 6. 目录

```text
apps/web/            前端（对话 / 工具卡 / 审批 / DAG / 审计）
packages/            18 个包（见 §2.1）
profiles/            9 个装配 profile 与 patch
                     （web / web-plan / mobile / desktop / im / headless / plan / sdk / subscription）
scripts/             54 个 verify-* 门禁、录制、演示脚本
design/bah-ds/       自研设计系统（与应用内分发副本逐字节一致）
docs/                管线、sentry、审计、前端、测试等落地文档
facts.md             演示材料唯一数字来源
```

## 7. 测试与资料

| 命令 | 范围 | 实测（2026-10-31） |
|---|---|---|
| `pnpm test` | 主仓 | 444 文件 / 5092 用例（2026-11-02 全量实测，见 facts.md） |
| `pnpm test:web` | 前端 | 47 文件 / 550 用例（全绿） |
| `pnpm -F @bah/eval test` | 评测包 | 22 文件 / 158 用例 |
| `pnpm test:snapshot` | 快照回放 | 13 文件 / 60 用例（全绿，含 03 单 `subscription-reminder` 与 04 单 `birthday-reminder`） |
| `pnpm gate` | 门禁 | 54 项 · 54 通过 |

三行测试口径**不能相加**：根 vitest 不包含 eval 与 web。更多数字见 [facts.md](facts.md)。

更多材料：[docs/](docs/)；部署见 [docs/deploy.md](docs/deploy.md)，
安全设计（威胁模型、攻击面与缺口）见 [docs/security-design.md](docs/security-design.md)，
漏洞披露见 [SECURITY.md](SECURITY.md)。
