# 安全设计：威胁模型、攻击面与缺口

> W19 交付件之三。**本文是"论证"，不是"打分表"**——打分表在
> [security-self-assessment.md](security-self-assessment.md)（HP-0…HP-4 的状态、评分、复现命令）。
> 两份交叉引用，不复制彼此内容：自评回答"做到什么程度"，本文回答"为什么这样做、漏了会怎样"。
>
> 事实口径见 §0（三份 W19 文档共用同一块，由脚本注入）。
> 每条防线都指向**代码位置**与**能跑的命令**，不写"全面防护""零信任"这类没有定义的词。

## 0. 事实表（三份文档共用）

<!-- BEGIN GENERATED:facts -->
| 事实 | 值 | 唯一来源（以代码为准，改文档不改代码） |
|---|---|---|
| plan 节点态 | **9 态**（pending、ready、running、succeeded、failed、skipped、blocked、cancelled、incident） | packages/runtime/src/plan/types.ts 的 `PLAN_NODE_STATES` |
| saga 状态 | **11 态**（CREATED、RUNNING、PENDING_RISK_REVIEW、GATE_HOLDING、COMPENSATING、PARTIALLY_COMPENSATED、COMPENSATION_DLQ、SUCCEEDED、ABORTED_CLEAN、COMPENSATED、MANUALLY_CLOSED） | packages/saga/src/state-machine/transitions.ts 的 `SAGA_TRANSITIONS` |
| 票据 TTL / 计划预算 | **120000 ms / 30000 ms**（预算 < TTL） | `PlanSettings.ticketTtlMs` / `planTimeoutMs`（本行由 planPlugin.validate 实算） |
| 工具数 | **19 个** | packages/bank/src/tools/specs.ts 的 `BANK_TOOL_SPECS` |
| 注册表条目（项） | **27** | `HOST_PLUGINS` 计数 |
| 门禁（项） | **51** | `scripts/verify-*.ts` 计数 |
| 覆盖率 | **89.96%（行口径，46778/52001 行，实测 2026-10-30）；16/18（包口径：包级行覆盖 ≥80% 的包数 / 参与统计的包数）** | docs/coverage-baseline.json（含测量命令） |
<!-- END GENERATED:facts -->

## 1. 资产、对手与"最坏的一天"

| 资产 | 一旦失守 | 谁能碰 |
|---|---|---|
| 资金动作（转账/理财/挂失） | 真金白银不可逆 | 用户（自然语言）、模型（提候选）、代码（判决） |
| 审批票据 | 绕过人工确认 = 后台随便扣钱 | 审批服务、工具管线 |
| 会话日志（会话/判决/证据包） | 监管材料失真、事后无法追责 | 持久化、审计链、重放器 |
| 知识库语料 | 用假费率/假条款诱导用户 | RAG 侧车、签名清单 |
| Web 渠道（7331） | 未授权触发对话、伪造审批 | 浏览器、脚本 |

对手假设（不假设对手比现实更弱）：

- **A1 直接调用者**：知道 HTTP 路由、拿到或猜到 token、会重放请求；
- **A2 恶意输入者**：在自然语言里塞指令（中英混排、base64、全角、零宽）；
- **A3 被替换的上游**：模型端点或 RAG 侧车返回伪造内容；
- **A4 内部组件失效**：判决件自己抛错、监听器写不进磁盘——**这一类最常被忽略**。

## 2. 威胁模型（简版 STRIDE，只列本项目真的会遇到的）

| STRIDE | 在本项目里的具体形态 | 主要防线 |
|---|---|---|
| **S**poofing | 冒充他去发起会话；伪造审批结论；伪造知识条目 | 凭证 401 + 同会话 403；票据五绑定；语料双层 HMAC |
| **T**ampering | 改金额/收款人；改票据参数；改会话日志 | 参数指纹 + `amountCents` 绑定；审计链哈希 + 重放核对 |
| **R**epudiation | "不是我批的" | 判决入链（`audit.jsonl`）+ 票据生命周期事件 + 证据包 |
| **I**nformation disclosure | 日志/回包泄漏手机号、卡号 | PII 脱敏；`permissions-policy`；`no-referrer` |
| **D**enial of service | 刷接口；上游挂起拖死主循环 | 限流 429；`requestTimeoutMs`；请求体上限 64 KiB |
| **E**levation of privilege | 绿级工具被当成写操作；被 block 的节点偷偷执行 | `verify-tiers` 门禁；`tools/pre-execute` 唯一阻断点；plan 的 blocked 不进管线 |

## 3. 攻击面清单（攻击面 → 现有防线 → 缺口，19 项）

> 这是本文的核心表。缺口列写"没有"也是一种结论——比被评委问出来强。

| # | 攻击面 | 现有防线 | 缺口（诚实列） |
|---|---|---|---|
| 1 | 用户自然语言提示注入 | `sentry` ingress：归一化 6 步（base64/全角/零宽）+ 9 类签名；命中只升风险分并审计，**永不**直接拒绝（检测器不可信） | 语义变体（同义改写）不命中签名；靠"检测只升风险、阻断靠确定性规则"兜住 |
| 2 | 工具参数注入 / 编码绕过 | `scanToolArgs` 在归一化后扫；危险规则 13 条 | 规则集是枚举，新编码要人工补 |
| 3 | 越权：跨会话使用票据 | `TicketBinding.sessionId` + 审批服务同源会话；跨会话 403 | 无（同一 token 下的多会话不在威胁模型内） |
| 4 | 越权：越用户调业务工具 | 会话绑定身份（`demoUserId`）；无身份一律 `no-identity` 拒绝 | 身份来自 profile 配置，不是登录态——这是仿真环境的前提 |
| 5 | 还原攻击：票据重放 | 一次性核销（`redeemed`）+ 参数指纹 + `expiresAt` | 无 |
| 6 | 金额篡改（浮点/精度） | 金额一律整数分；`amountPath` 绑定金额；断言核验 | 历史数据里的"元"入参靠工具 schema 约束，不是运行时全量校验 |
| 7 | 绕过审批直接写 | `tools/pre-execute` 是**唯一**阻断点；写工具没有票据即拒；`verify-tiers` 门禁防 tier 声明漂移 | 无（这是本项目的核心不变量） |
| 8 | 伪造审批 HTTP 请求 | Bearer 401 → CSRF 403 → 同会话 403 三层；`/api/admin/*` 豁免 CSRF 但有独立 token + 回环来源 | 无 |
| 9 | CSRF（跨站表单） | 双提交 cookie + 同源 Origin；顺序固定 401 → 403 → 业务 | 无 |
| 10 | token 暴力破解 | 每进程随机生成（未配环境变量时）；限流 429；SSE 只允许查询参数带 token | token 无过期时间（单进程演示形态） |
| 11 | XSS（渲染模型输出） | 前端全量 `textContent`（禁 `innerHTML`）+ CSP `script-src 'self'`、`object-src 'none'`、`frame-ancestors 'none'` | 无 |
| 12 | 点击劫持 / 嵌入 | `x-frame-options: DENY` + CSP `frame-ancestors 'none'` | 无 |
| 13 | 大请求打爆内存 | `MAX_BODY_BYTES = 64 KiB` → 413；限流 | 无 |
| 14 | 上游模型挂起 | `requestTimeoutMs`（web profile 30 s）+ 失败落 `assistant/attempt` | 没有熔断降级到备用模型（只报错） |
| 15 | 知识库被整体替换 | 文件级 + 条目级 HMAC-SHA256；命中逐条验签；不通过 → 拒答信封 | **HP-2 响应信封未签名**（见 §4） |
| 16 | 审计日志被篡改 | 判决链哈希串联（`audit.jsonl`）+ 独立重放器 `--verify` 三判据 | 链是本地文件，没有外部锚定（时间戳/第三方存证） |
| 17 | 判决件自身失效 | fail-closed：核验组件抛错 → 阻断并替换模型可见内容（`verifier-unavailable`） | 只覆盖已知的两个接缝（post-execute / turn-stopping） |
| 18 | 策略文件被替换 / 被降级 | 编译期禁止 `lower`/降级；`lock.json` 语义+源摘要；registry 摘要核对；默认 bundle 与 legacy 穷举等价；`verify-policy-{bundle,conformance,hardcode,registry}` 四条门禁 | 本地链没有外部锚定；生产 Ed25519 密钥分发/轮换流程未落地（S4 只做可选验签，演示 unsigned） |
| 19 | 热重载竞态 / 坏候选半生效 | 先编译后原子替换；失败保持旧版并发 `policy/reload-rejected`；参数绑定在激活前复校；在途判决持旧快照 | 单进程文件监听（`fs.watchFile` 轮询），没有分布式一致性；多实例部署不在当前形态内 |

### 3.1 三处"顺序即安全"的设计（顺序错了，上面一半的防线都会失效）

1. **闸的顺序**：限流 → 管理面豁免 → Bearer 401 → CSRF 403 → 业务 423/409。
   反过来会把"缺凭证"报成 403（信息泄漏），或把"停机"误报成跨站攻击。
2. **判定顺序**：危险规则 → PII（仅审计）→ 风险分 → 预算 → 熔断 → 签票。
   签票放最后，避免"票已发出才发现会话被冻结"。
3. **HALT 与风险分**：`HALT` 判定在 `riskScore` 之前——停机是绝对状态，
   不该被"分数还低"绕过。

## 4. 未实现清单（9 项，每项写清"为什么不做"与"影响面"）

> 施工单要求 ≥5 项。这一节不是道歉，是**接口**：评委会问的每一个"那你们怎么防 X"，
> 答案要么在这里，要么在上面 §3 的"现有防线"里。
>
> **HP-4（工具出参运行时契约校验）已实现，不在本表**：`ToolPipeline` 在每次工具调用后按
> `resultSchema` 运行时校验，畸形返回报 `tool-result-invalid` 并落 `isError`
> （`packages/runtime/src/tools/pipeline.ts:285-292`）；19 个银行工具全覆盖
> （`packages/bank/src/tools/result-schemas.ts` 19 个键，装配在
> `packages/host/src/boot/plugins/bank-tools.ts:283-295`），直测
> `packages/runtime/src/tools/contracts.test.ts:172-197`。

| # | 未实现 | 为什么不做（取舍） | 影响面 |
|---|---|---|---|
| 1 | **HP-2：RAG 响应信封签名** | 需要跨语言黄金向量与密钥分发，收益集中在"证明对端身份"；本轮把预算放在"条目级验签 + 拒答"上（伪造/漂移必被拒） | 服务端**整体被替换**时，只能保证"返回条目必须与我方签名清单逐字一致"，不能证明对方身份。生产接入需补 |
| 2 | **强验证接真实渠道** | `verify.provider` 默认是测试网关适配器（`mock`），真实人脸/短信/U 盾需要外部服务与合规审批 | "红级已过 MFA"只在仿真环境成立。这是**配置缺口**，不是代码缺口 |
| 3 | **对抗集 H-14 / H-15（幻觉族 13/15）** | 两条期望是 `degrade`（把无证据断言降级为【未核实】），实际 `allowed`；归因 `rule-gap`：断言抽取没覆盖这两类表述（H-13 的保本/收益承诺已由第六类断言收口） | 无证据的定性表述可能不带【未核实】落账。属于**召回**缺口，不是绕过（资金动作仍受审批约束） |
| 4 | **plan 内写工具的补偿** | `saga-bridge` 在 `profiles/plan` 显式关闭（否则 `transfer_create` 被再展开，一条 `plan/node-result` 对上两条 `tool/call`） | plan 里第 2 步扣款、第 3 步失败时**没有自动冲正**；正确做法是让 plan 编排一整笔 saga，这是 P2 的活 |
| 5 | **plan 动态 args 跨 `resume`** | 节点输出只存在内存里，续跑时无法还原上游 output；存进会话日志会把大对象写进审计面 | 需要"重做一笔已成功的转账"时，只能新 `planId` + 冲正原笔（两张计划用 `meta` 关联） |
| 6 | **`incident` 状态的真实触发源** | 本仓全内存 mock，没有"外部不可用"的真实来源；可达性靠单测 + 宿主 stub 工具 | Web 的 DAG 视图按 `tool/call` 派生，**不区分** `incident` 与 `failed`；裁判问"什么时候会 incident"要按 `docs/plan.md` 讲条件，不能指屏幕 |
| 7 | **真定时调度（"生日前 2 天自动下单"）** | `@bah/schedule` 是 P2；未来时间的定时转账被银行工具显式拒绝（`unsupported-schedule`）。演示里"待定时"是壳层文案（预演叙事），背后没有任何定时器或调度事件 | 系统**不会**到点自动扣款；用户必须手动确认每一步。演示材料不得写成"已实现定时" |
| 8 | **外部商户真实通道** | 鲜花/蛋糕商户是仿真种子收款人（`forge` 白名单），走既有 `transfer_create` 表达"付款给商户"；商户履约（选花、配送）在银行域外 | 资金流可审计，但不存在真实商户下单/退款通道；对账只覆盖银行侧 |
| 9 | **人工接管与分叉会话的持久化 / 多会话切换** | 接管状态在进程内（重启回 `active`）；`POST /api/session/fork` 产生的新会话也在进程内，HTTP 渠道仍服务原会话——把渠道切到新会话属多会话宿主（D4） | 重启后接管状态丢失；"回到上一步"目前只给分叉元数据与提示，不切换对话流。两者都**不**影响旧会话的审计完整性（旧卷原样封存） |

补充（不算"未实现"，但要主动说）：

- **覆盖率还有两个包没到 80%**：`memory-store` 72.68% 与 `eval` 43.12%（行口径 89.06%＝41749/46877，仅 `packages/*/src`；包口径 16/18，见事实表）。`eval` 的行数多在场景数据装载、`memory-store` 多在存储适配，属于评测/记忆 harness 而非主资金路径。
- **策略生产签名密钥的分发/轮换未落地**：S4 提供 Ed25519 可选验签与 `policy:rules.signature`
  路径，密钥不进仓；演示 profile 仍 `requireSignature: false`，链上策略判决是 `unsigned`。
  生产强制签名需要密钥托管与轮换流程，登记到 S6；不能据此宣称"策略文件防篡改"。
- **`security-self-assessment.md` 里的工具数曾停在更早的一版**（现为 19）：本轮已顺手改正，
  该文档的评分与状态不受影响。

## 5. 每条防线的复现命令（评委可逐条抽验）

```bash
# ① 三级权限与票据：3 个工具、只 1 次审批
npx tsx scripts/demo-plan.ts --only=ok

# ② 失败传播闭包：D.blockedBy = [B, C]，被 block 的节点零 tool/call
npx tsx scripts/demo-plan.ts --only=diamond

# ③ 判决件失效时 fail-closed（原始结果不进模型可见内容）
npx tsx scripts/demo-verifier-fail.ts

# ④ 知识语料验签（不通过则拒答）
npx tsx scripts/sign-knowledge.ts --check

# ⑤ 攻击面回归：45 例对抗（44 计入分母）
npx tsx scripts/eval.ts --adversarial

# ⑥ 审计链可独立验证（真实 web 会话）
npx tsx scripts/replay.ts --session <id> --dir <jsonlDir> --verify
```

`--adversarial` 会重写 `.ci-artifacts/eval/adversarial-report.json`；
**`--smoke` 会把它覆盖成 9 例版本**，所以全量要放在最后跑。

## 6. 与赛题条款的对应

逐条对应表在 [security-self-assessment.md](security-self-assessment.md) §11，
本文不复制（两份文档各写一遍必然打架）。本文只补充一条口径：
**"票据 + 强验证 + 断言核验"三件事共同构成"资金动作可控"**，
单独拿任何一件讲都会被追问缺口（例如只讲票据会被问"模型胡说金额怎么办"）。
