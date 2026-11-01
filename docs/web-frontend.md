# Web 前端施工文档（施工单 13 落地版）

> 版本：v1.2（施工后按实际代码回填；评审稿原件留仓库外归档）
> 对应施工单：[`13-Web前端.md`](../../BAH-施工文档集/13-Web前端.md)
> 视觉标准：`design/bah-ds/`（BAH DS 自研设计系统，Light-only）
> 出口：`pnpm typecheck && pnpm test && pnpm test:web && pnpm gate` 全绿，`pnpm web` 可独立运行五视图

---

## 0. 一句话架构

**事件是唯一事实，帧是唯一渲染输入。**

```text
会话日志（append-only，权威）
   │  session/event（emit）
   ▼
@bah/channels/web  · 纯投影（无 DOM / 无 HTTP / 无时钟）
   │  WebFrame[]（可快照、可 diff、可回放）
   ▼
@bah/host · channel:web 插件（HTTP + SSE + 静态资源 + 审批应答者）
   │  SSE / REST
   ▼
apps/web · 纯原生 DOM 渲染（只吃帧，不推导业务）
```

前端**不维护平行状态**（施工单 13 §7 第一条风险的对策）：任何可见结论都能追到一条 `seq`。

---

## 1. 出口标准映射（施工单 13 §0）

| # | 出口标准 | 本设计的落点 | 验证 |
|---|---|---|---|
| 1 | `ChannelAdapter` 落地，Web 首个实现 | `packages/channels/src/web/adapter.ts` | T-WEB-007a |
| 2 | 五视图可用 | `apps/web/src/views/*` | T-WEB-002/003/006/008 |
| 3 | `seq` 增量推送、断线续订不丢不重 | `follow.ts` + `GET /api/events?since=` | T-WEB-001 |
| 4 | 纯原生：无 Vue/React/组件库 | 全仓零框架依赖 | `verify-web` 门禁 |
| 5 | 注入 boots 后可独立运行 | `apps/web` 静态可跑；数据只经 `transport` | T-WEB-008 |
| 6 | 幻觉防护 UI 降级 | `amount.ts` 的 `confirmed` 判定 | T-WEB-005 |

---

## 2. 视觉基线（BAH DS 自研设计系统，全端唯一标准）

### 2.1 消费方式

`design/bah-ds/` 是自研令牌的**唯一定义处**，`apps/web/styles/ds/` 是它的**逐字节分发副本**：

| 基线定义 | 分发副本 | 用途 |
|---|---|---|
| `colors_and_type.css` | `apps/web/styles/ds/colors_and_type.css` | 全部颜色/字号/圆角/间距令牌 |
| `components.css` | `apps/web/styles/ds/components.css` | `.ds-*` 原子组件 |
| `assets/icons/*.svg` | `apps/web/assets/icons/`（按需复制） | 唯一图标来源 |

门禁 `verify-web` 校验两边 sha256 一致：**改了一处没同步另一处 = 直接红**。禁止在 `apps/web` 里重新发明令牌。

### 2.2 硬规则（来自自研 `design/bah-ds/SKILL.md`，逐条落到本工程）

1. **Light-only**：不加 `prefers-color-scheme`、不加主题开关、不加 dark 覆盖。
2. **令牌优先**：`apps/web/styles/app.css` 里**不允许出现十六进制色值**（门禁扫描）。颜色只能 `var(--…)`。
3. **品牌色稀缺**：`--bg-brand` 只用于每屏唯一主行动（发送按钮）与品牌标识点；选中态一律 `--bg-overlay-l1..l3`。
4. **表面分层**：页面 `--bg-base-default`；卡片 `--bg-base-secondary`；输入/内联控件 `--bg-overlay-l1`；浮层 `--bg-menu`。不把 default 面板放进 secondary 容器里。
5. **容器间距**：相关卡片 ≥ `--spacer-16`，卡片组 ≥ `--spacer-24`，区块 ≥ `--spacer-32`。
6. **不嵌套边框容器**：`.ds-card` 内不再放 `.ds-card`，用分割线与间距。
7. **字号基线** `--body-base-*`（14/20）；金额、ID、序号用 `--code-editor-font-family` + `tabular-nums`；KPI 大数字用 `--font-family-metric`。
8. **图标**：只用本地 SVG，默认 16×16，密集控件 14×14，大图标 24×24；功能性图标带 `aria-hidden="true"`，纯图标按钮必须有 `aria-label`。
9. **动效**：hover 120ms / 状态切换 200ms / 布局揭示 ≤300ms，位移 ≤4px，不用 `scale>1.05`；`prefers-reduced-motion` 全部降级为无动画。
10. **可访问性**：正文对比度 ≥4.5:1，焦点环不可移除，键盘可达。
11. **禁止左侧竖色条**：卡片、面板、行、气泡**不得**靠"最左边一条竖色带"表达状态或层级。四种写法一律禁止并被门禁 `no-left-accent` 拦截：
    `border-left-width` ≥3px、`border-left` / `border-inline-start` 取 `--status-*` 或 `--bg-brand`、`::before`/`::after` 贴左边缘画色条、`box-shadow: inset 3px 0 0 …`。
    状态一律用 `.ds-tag` 文案 + 图标着色表达；确实需要容器级状态时，用**整圈** `border-color` + status surface 底色（`.ds-notif--*` 的做法）。
    1px 中性分隔线（`--border-neutral-*`）不算色条，允许。

### 2.3 与施工单 13 §2 "Apple 设计语言"的调和

施工单要求「严格圆角、cubic-bezier、毛玻璃层次」，BAH DS 要求「quiet by default、避免装饰」。冲突时**视觉取值服从 BAH DS 令牌**，只保留 Apple 的**取向**：

| 施工单表述 | 本工程落地 | 理由 |
|---|---|---|
| 严格圆角 | `--radius-8` 容器、`--radius-12` 卡片/弹窗 | 令牌即规范 |
| cubic-bezier 平滑 | 统一 `--motion-standard: cubic-bezier(0.2, 0, 0, 1)`（时长取 120/200/300ms） | 令牌包无动效变量，时长按 SKILL.md 固定 |
| 毛玻璃层次 | **仅** 顶栏与弹窗遮罩用 `backdrop-filter: blur(12px)`，底色仍取令牌 | 令牌包无亚克力层级，滥用会破坏 surface depth |

> 这一条是审核意见 B-3 的处置结果：不允许为了"高级感"新增 glow / 渐变 / 假图表。

---

## 3. 分层与依赖方向（含一次必要的依赖翻转）

```text
packages/core        api / events / context
   ▲
packages/runtime     session / agent / pipeline
   ▲
packages/channels    ← 纯投影层（@bah/channels/web）
   ▲
packages/host        ← channel:web 插件（HTTP/SSE/审批应答者）
   ▲
packages/cli         ← 启动面（--serve）
```

**翻转说明**：M0 骨架里 `packages/channels` 声明了 `@bah/host` 依赖，但 `src/**` 全是 `export {}`，没有任何实际引用。渠道适配器要投影会话事件、又被宿主插件引用，正确方向是 `host → channels`。本次把 `channels/package.json` 的依赖改为 `@bah/core`，`tsconfig` 引用改为 `../core`；`host` 反向依赖 `channels`。

> 不这么做就只能把插件塞进 channels 再让 `HOST_PLUGINS` 反向 import，形成包级环——`tsc -b` 会直接失败，且"谁依赖谁"再也说不清。

---

## 4. 帧模型（`WebFrame`）

### 4.1 为什么是"帧"而不是"渲染整页"

- **可快照**：同一串事件 → 同一串帧（纯函数，无时钟、无随机、无 DOM），`diff=0` 是构造出来的性质，不是碰巧。
- **可续订**：断线后服务端用同一归约器重放，客户端只做 `replace(snapshot)`，不需要"倒推 DOM 该怎么回滚"。
- **可测试**：帧是纯数据，node 侧快照即可；DOM 侧只测"帧 → 节点"。

### 4.2 帧联合（判别标签 + `assertNever` 收尾）

| `kind` | 触发事件 | 渲染物 |
|---|---|---|
| `turn` | `turn/start`、`turn/end` | 轮次分隔与结束原因（`guard-stopped` 与 `failed` 文案必须不同） |
| `message` | `user/message`、`assistant/message` | 气泡（`role` / `blocks` / `at` / `seq`） |
| `delta` | `llm/stream` 的 `text-delta`（ephemeral） | 追加到"正在生成"的气泡，权威消息到达即被替换 |
| `tool` | `tool/call`、`tool/result`、`approval/decided` | 工具卡片三态 + 卡片模板 |
| `approval` | `approval/asked` | 审批弹窗六要素 |
| `approval-closed` | `approval/decided` | 弹窗收尾（`allowed-once`/`rejected`/`cancelled`/`unavailable`） |
| `notice` | `tool/result.isError`、`turn/end.failed`、`compaction/summary`、`sentry/*` | 行内提示（状态语义色 + 理由码） |
| `audit` | 全部 durable 事件中的"有判决含义"者 | 审计时间线条目 |
| `dag` | `tool/call`/`tool/result` 聚合 | 调用图（见 §5.4） |
| `choice` | `prompt_ask` 的 `tool/result` | 选择题卡：点选 = 发一条普通用户消息；帧里**没有**票据，不走审批通道 |
| `goal` | `goal_set` 的 `tool/result` | 目标条（仅 plan 类 profile；`web` profile 当前不注册该工具） |
| `todo` | `plan/*` 派生（不落账） | 待办清单（仅 plan 类 profile；`web` profile 无 plan 事件） |
| `effects` | 成功的写操作 `tool/result` | "已发生的操作"只读清单（中断/断线后回答"钱动了没有"） |
| `snapshot` | 连接/重同步 | 全量帧替换 + `maxSeq` |

不变量（写进类型与测试）：

1. 每帧带 `seq`（`snapshot` 除外）；`delta` 带 `at` 但**不占 seq**。
2. 归约器对同一 `(state, event)` 必须幂等：重复喂同一条事件不产生第二帧。
3. 任何帧都能追到 `seq`；审计面板的每条都能回跳。

### 4.3 卡片的渲染边界（施工后修正：R-WEB-D6）

**重要事实**：`UiCard`（`presentCall` / `presentResult` 的产物）当前**不落账**——
`ToolPipeline` 把它们算出来交给 `AgentLoop`，但没有任何持久化或事件通道承载它们。
因此"渠道按 `kind` 选 `UiCard` 模板"在**回放场景下无法实现**（日志里没有 kind）。

落地口径（与施工单 13 §2 的"从原始事件 + 持久化结果元数据派生"一致）：

```text
tool/call.args ──▶ 金额（元→分）/ 收款人 / 品类
tool/result.content ──▶ 正文、风险提示 ID、引用
tool/call.tier ──▶ 权限级别
tool/result.code/isError ──▶ 理由码与三态
```

| 模板 | 判定来源（工具名） | 关键点 |
|---|---|---|
| `transfer` | `transfer_*` | 金额、收款人、流水号/票据 ID（来自正文） |
| `wealth` | `wealth_*` | **强制**渲染正文里的 `风险提示：<disclaimerId>`，并从正文剥离后单独展示 |
| `ledger` | `account_*` / `txn_*` / `bill_*` | 正文按行保留（`pre` + `pre-wrap`） |
| `analysis` | `analysis_calc` | 结果与耗时 |
| `verify` | `verify_*` | 渠道、剩余次数、锁定提示 |
| `knowledge` | `knowledge_*` | 引用与拒答理由码 |
| `generic` | 其余 | 只展示正文 + 参数里的金额/收款人，不猜语义 |

> 若将来 `tool/call` 带上 `UiCard`，只需改 `cards.ts` 的输入，五个视图不动。
> 兜底模板仍是硬要求：领域包随时可能新增工具，渠道不能因为"没见过"就白屏。

---

## 5. 五视图规格

### 5.1 对话流

- 结构：`header`（品牌 + 会话 ID + 连接状态）/ `main`（消息列）/ `composer`（输入 + 发送 + 中断）。
- 流式：`delta` 帧进入"草稿气泡"（`data-streaming="true"`），`assistant/message` 到达时整体替换草稿——避免"半句话永久残留"。
- 选择题（`choice`）：点选把选项 **label** 当普通用户消息发 `POST /api/turn`；"手动输入"出口常驻（零请求，只交焦点）；发送失败恢复可点并给行内错误。
- 已发生操作（`effects`）：只读清单，零按钮零链接；每轮一张，按 `effects:{turn}` 替换。它不是资金审计（审计链在 `audit.jsonl`）。
- 正文：轻量 Markdown（GFM 表格 / 列表 / 围栏代码块 / 行内强调）。表格用 `.md-table-wrap` 横向滚动，窄屏不撑破气泡。
- 答后收口：最后一轮结束、没有流式草稿、没有待选卡时，会话末尾出现**唯一一条**反馈行 + 两条按最近一轮内容推导的快捷追问；新一轮开始即收起。
- 滚动：出现新用户消息 / 用户发送时跳到底部；本轮第一段助手正文出现时只滚到正文顶部**一次**，生成期间冻结，不再跟随 delta / 工具帧 / 收口块。
- 安全提醒：桌面壳放在顶栏 chip（全文在 `title`，可收起），不再占会话行；移动壳仍在会话流顶部。
- 长对话：按 `turn` 分组，**不使用** `content-visibility: auto`——离屏条目按占位高度估算，滚到底后真实高度陆续结算会让程序化定位反复漂移（2026-11-01 走查实测）。
- 空态：一条 `.ds-empty`，说明三幕演示入口。

### 5.2 工具卡片三态

| 状态 | 来源 | 视觉 |
|---|---|---|
| `pending` | `tool/call` 到达、无 `tool/result` | "待执行" `.ds-tag--warning` + 时钟图标着色 `--status-warning-default` |
| `done` | `tool/result.isError === false` | "已完成" `.ds-tag--success` + 对勾图标着色；卡片模板渲染结果 |
| `denied` | `tool/result.isError === true` 且带 `code` | "已拦截" `.ds-tag--danger` + 错误图标着色 + 理由码 + 原因；`analysis` 可折叠 |

- 三态靠**图标着色 + 状态标签**表达，卡片边框恒为 1px `--border-neutral-l1`。
  曾用左侧 3px 状态色竖条（`border-left-width` + `border-left-color`），2026-10-23 按视觉口径否决，见 §2.2 第 11 条与门禁 `no-left-accent`。
- 三态互斥且不可回退（事件顺序保证），重复帧只更新不追加（按 `callId` 复用节点）。
- 金额字段统一走 §6 的降级判定。

### 5.3 审批弹窗（六要素 + 服务端明细）

| 字段 | 帧字段 | 来源事件 | 缺失时 |
|---|---|---|---|
| 操作类型 | `operation`（工具名 + 中文标题） | `approval/asked.name` + 卡片标题 | 显示工具名 |
| **执行明细**（2026-10-31） | `details`（`{label,value,emphasis?}[]`，最多 12 行，超出置 `detailsTruncated`） | `approval/asked.details`（**服务端签发**，见 `packages/bank/src/tools/approval-details.ts`） | 不渲染明细块，退回下面几行 |
| 金额 | `amountText` / `amountConfirmed` | `approval/asked.amount`；同 turn 成功 `transfer_preview` 且收款人+金额一致时已确认 | 非金额操作不渲染该行；金额操作无预演或金额不一致显示"待确认"并置灰 |
| 收款人 | `payeeName` | 同 turn 的 `tool/call.args.payee.name` | 显示"—" |
| 收款手机（可选） | `payeePhone`（**已脱敏**：前 3 后 4） | 同 turn 的 `tool/call.args.payee.phone` | 不显示该行；完整号码不进帧 |
| 手续费（可选） | `feeText` | 本 turn `transfer_preview` 结果正文（`手续费 ¥…`） | 不显示该行；不从金额/费率反推 |
| 风险级别 | `tier` | `tool/call.tier.level` + 三级徽标 | 缺省 `unknown`，不猜 |
| 等待时长 | `waited`（客户端计时，纯视觉） | — | 永远显示"已等待 mm:ss"；**不做倒计时**（见 R-WEB-D8） |
| 拒绝理由 | 输入框 → `POST /api/approval/:ticketId` | 回传 `approval/decided(rejected)` | 拒绝时必填（前端校验 + 后端再校验） |

- **明细优先**：帧上出现 `details` 时，金额/收款人/收款手机/手续费**只从明细渲染**，
  上面那四行不再单独出现——同一笔钱在同一张卡里出现两个来源，用户只能猜哪个是真的
  （卡片冻结/挂失这类非金额操作也因此不再显示空的金额行）。
- 明细的数值一律由服务端从 `deps.core` 现读，前端**不重算、不重新格式化**，
  强调只用字体（金额等宽）与 `ds-tag`（风险），**不用左侧竖色条**。
- 红级：`challenge` 存在时先展示强验证面板（模拟取景框 / 扫描线），验证通过才允许"批准"；未验证时批准按钮禁用。
- 超时：**客户端不判超时**。等待时长只是"等了多久"的展示；结论由服务端 `approval/decided(unavailable)` 决定，
  UI 呈现"未执行"（T-WEB-004）。原因见 R-WEB-D8：`approval/asked` 不带票据 TTL，编一个倒计时等于在资金操作上说假话。
- 关闭方式：`Esc` = 取消（`cancelled`），点击遮罩 = 取消，`Tab` 焦点锁定在弹窗内。

### 5.4 DAG 视图

> 施工单 13 §2.1 要求"plan 提案 / blocked 标记"，但 `plan/*` 事件属施工单 14，当前不存在。**偏差 R-WEB-D1**：本版从 `tool/call` + `tool/result` 派生**调用图**，语义与验收口径一致（节点携带权限级别、失败下游灰显），后续 `plan/` 事件到位后替换数据源、视图不动。

- 节点：`turn` → `step` → `tool call`（三层泳道）。
- 边：同 step 内按 `seq` 串行；step 首尾跨 step 连接。
- 标记：`tier`（绿/黄/红徽标）、`denied`/`failed`（错误色）、**下游 `blocked`**（灰显 + "已阻断"）。
- 布局：SVG + 分层坐标（x = 层号 × 间距，y = 序号），不引入图形库。

### 5.5 审计时间线

- 内容：`approval/*`、`ticket/*`、`tool/result.code`、`sentry/*`、`knowledge/*`、`read/subscriptions`、`sub/cancelled`、`sub/authorization-revoked`、`sub/watch-updated`、`turn/end`。
- 分类：审批 / 票据 / 工具 / 安全 / 知识 / **订阅** / 轮次（`AuditFrame.category`；界面按分类上色，未知分类退回原文）。
- 每条：时刻（`HH:MM:SS`）、类型标签、摘要、理由码（等宽字体）、`seq`；有 `detail` 时给「查看明细」的 `<details>`，按标签/值展开。
- 明细白名单：服务端只收 `kind` / `turn` / `callId` / `name` / `ruleId` / `stage` / `reason` / `code` 等解释字段，工具参数、结果、用户原话与会话 ID 不进帧。`sentry/trace` 的摘要说实际轨迹类型（`turn-start` / `tool-call` / `verdict`），不再统一写"命中"。
- 附加：顶部四格判决计数（审批 / 拒绝 / 取消 / 阻断）+ 分类计数；四格全零且有审计时显示「本会话没有审批事件（只有只读工具 / 安全轨迹）」，不把"零"伪装成故障或成就。
- 读取：`GET /api/audit?since=` 可选；本版直接复用帧流（`audit` 帧），少一条链路。

### 5.6 订阅卡片的「即将扣款」块

- 数据源只有一处：`sub_list` 执行时落账的 `read/subscriptions` 事件（ADR-0007 冻结载荷）。`UiCard` 不落账，正文也拿不到结构化清单，**不能**从别处凑。
- 口径与 bank 槽位「即将扣款」逐条一致：只看 `active`、7 天窗口、`reminderAheadDays` 收紧、到期升序（同刻按 `subscriptionId`）；最多列 5 条，其余只报数。
- 窗口基准是**事件自己的 `at`**，不读墙上时钟——回放两次必须逐字相同；块上写明「基于近 N 天 M 笔流水 · 生成于 YYYY-MM-DD」，推断不许读成现况。
- 只在**成功结果**上出现；待执行帧与失败帧都不带（失败说明这次没读到，不拿上一轮的清单充数）；跨 turn 不复用。

### 5.7 账单报告卡的「分类汇总」块

- 数据源只有一处：`bill_report` 执行时落账的 `read/bill-report` 事件（带完整 `analysis`）。卡片**不**从报告正文反解数字——正文是给模型读的一句话，表格要靠结构化数据（与 §5.6、AA 参与人清单同一处理）。
- 呈现：账期 / 收入 / 支出 / 环比 / 异常条数进 `fields`，分类进 `table`（分类 · 金额 · 占比），收款人前 5 与异常说明进 `note`（两行，`white-space: pre-line`）。有了块就不再渲染 `body`，同一段报告不在一张卡里出现两遍。
- 口径：分类中文镜像 `presenters.ts` 的 `CATEGORY_LABEL`、账期口径镜像 `queries.ts` 的 `REPORT_PERIOD_LABEL`（渠道不发明第三套说法）；金额一律 `formatCents` 出元，事件里的「分」不外泄。
- 形状不合格就整块不产（`billReportBlockOf` 返回 `undefined`），卡片退回正文排版——宁可少一张表，不拼一张缺总数的表；同样只在成功结果上出现、跨 turn 不复用。
- 银行侧同步收紧：`bill_analyze` / `bill_report` 的工具结果正文写中文分类，异常说明写 `大额支出 ¥3,003.70` 而不是 `300370 分`——这份正文模型会原样念给客户。

---

## 6. 金额降级（幻觉防护 UI 侧）

判定规则（纯函数，`amount.ts`）：

```text
confirmed(amount, callId) =
  同一 turn 内存在该 callId 的 tool/result
  且 result.isError === false
  且 result 的来源是工具（不是模型文本）
```

- 不满足 → `confirmed: false`，UI 渲染 `¥ —` + `.ds-tag--warning` "待确认"，并用 `--text-tertiary`。
- 满足 → 原样渲染 presenter 给的 `amountText`（presenter 已把分格式化成 `¥1,234.56`，渠道不重算）。
- `wealth.*` 卡片：`disclaimerId` 必须渲染（缺 `disclaimerId` 时渲染"风险提示缺失"并用错误色——宁可丑，不可静默）。
- 该判定只影响**渲染**，不改事件、不改卡片数据。

---

## 7. 协议（HTTP + SSE）

路由表**由代码生成**（`web/router.ts` 的 `ROUTES`），不要在本文手写——表一旦分叉，
评审就会相信一个不存在的入口。

<!-- web-routes:begin -->
| 方法 | 路径 | 语义 | 鉴权 | 状态码 |
|---|---|---|---|---|
| GET | `/api/health` | 探活：`{ ok, lastSeq, pendingTicketCount }`（只给数量，不给票据 ID） | 公开 | 200 |
| POST | `/api/auth/login` | 登录 `{ userId, password }` → 下发 HttpOnly 会话 cookie 并轮换 CSRF；失败与"用户不存在"同形 | 公开 + CSRF | 200 / 400 / 401 / 403 / 409 / 503 |
| POST | `/api/auth/logout` | 登出（幂等：没有会话也 200，但会清 cookie；public + CSRF） | 公开 + CSRF | 200 / 403 |
| GET | `/api/auth/me` | 自查：`{ tenant, userId, roles, expiresAt, mode }`（**不回 sid**） | Web 凭证（任一角色） | 200 / 401 |
| POST | `/api/admin/sentry/unfreeze` | 人工解冻断路器（默认关闭，见 §7.1） | admin token + 回环 | 200 / 400 / 401 / 403 / 404 / 405 / 503 |
| POST | `/api/admin/halt` | 人工进入 HALT（W07，见 §7.1.1）；`changed:false` 表示本来就在 HALT | admin token + 回环 | 200 / 400 / 401 / 403 / 404 / 405 / 503 |
| POST | `/api/admin/halt/unfreeze-request` | 会话内发起一次 U 盾 MFA 审批，签发解除票据（无应答者 → 409） | admin token + 回环 | 200 / 400 / 401 / 403 / 404 / 405 / 409 / 503 |
| POST | `/api/admin/halt/unfreeze` | 凭票据解除 HALT（唯一解除路径；没有 `force`） | admin token + 回环 | 200 / 400 / 401 / 403 / 404 / 405 / 409 / 503 |
| GET | `/api/session` | 会话与能力位：`{ sessionId, lastSeq, capabilities }` | Web 凭证（任一角色） | 200 / 401 |
| GET | `/api/events` | SSE：先全量快照，再推 frame / delta / 心跳注释；static 模式凭证可用 `?token=`（password 模式只认 cookie）；连接满 → 503 | Web 凭证（任一角色） | 200 / 400 / 401 / 503 |
| GET | `/api/metrics` | 单机指标：turn / 工具成功失败 / 审批分布 / token 与成本 / 工具耗时分位 / SSE 连接数；第一层带 `tenant` | Web 凭证（任一角色） | 200 / 400 / 401 |
| GET | `/api/trace` | 轨迹：事件派生的 span 森林；`?format=chrome` 导出 Chrome Trace（Perfetto 可直接打开）；D4：当前按调试面处理（ROLES），生产应收窄到 auditor/admin | Web 凭证（任一角色） | 200 / 400 / 401 / 503 |
| POST | `/api/session/fork` | 在 turn 边界分叉新会话 `{ turn }`（旧会话原样封存；新会话仅进程内存在） | Web 凭证（customer / admin） + CSRF | 200 / 400 / 401 / 403 / 404 / 405 / 409 / 500 |
| POST | `/api/turn` | 提交一轮输入 `{ text }` → 入队并驱动；202 = 已入队，HALT 期间 423；接管期间 202 落账不驱动 | Web 凭证（customer） + CSRF | 202 / 400 / 401 / 403 / 423 / 503 |
| POST | `/api/interrupt` | 打断当前 turn `{ reason? }`（理由进审计）；客户专属，坐席 403 | Web 凭证（customer） + CSRF | 200 / 401 / 403 / 503 |
| POST | `/api/approval/:ticketId` | 提交审批结论 `{ decision, reason? }`；跨会话票据 403；客户专属 | Web 凭证（customer） + CSRF | 200 / 400 / 401 / 403 / 404 / 409 |
| POST | `/api/verify/:ticketId` | 红级票据的强验证（挑战由 VerifyService 签发）；客户专属 | Web 凭证（customer） + CSRF | 200 / 400 / 401 / 403 / 404 |
| POST | `/api/secure/password` | 安全页改密 `{ ticketId, oldPassword, newPassword }` → `{ ok, changedAt }`；**绝不回显**任何密码字段 | Web 凭证（customer） + CSRF | 200 / 400 / 401 / 403 / 404 / 409 / 423 |
| GET | `/api/handoff` | 人工接管摘要：`{ active, sessionId, lastSeq, turns, pendingTickets, messages[], reason?, at?, waitedMs, overdue, claimed, operatorMessages, operator?, requestedBy?, operatorId? }` | Web 凭证（任一角色） | 200 / 401 |
| POST | `/api/handoff` | 请求人工接管 `{ reason? }`：进入者从登录主体派生（`requestedBy`）；接管期间 `/api/turn` 202 落账但不驱动模型 | Web 凭证（customer / agent / admin） + CSRF | 200 / 400 / 401 / 403 / 409 |
| POST | `/api/handoff/resume` | 交回会话 `{ handover? }`（操作者从登录主体派生，body 不接受 operator）；未接管时 409 | Web 凭证（agent / admin） + CSRF | 200 / 400 / 401 / 403 / 409 |
| POST | `/api/handoff/message` | 坐席发言 `{ text }`：落 `handoff/operator-message`（不进模型历史）；发言主体从登录主体派生 | Web 凭证（agent / admin） + CSRF | 200 / 400 / 401 / 403 / 404 / 409 / 413 |
| POST | `/api/handoff/claim` | 坐席认领（幂等；换人 409）——认领只改显示与审计，不改变 `/api/turn` 的接管语义 | Web 凭证（agent / admin） + CSRF | 200 / 401 / 403 / 404 / 409 |
| POST | `/api/handoff/heartbeat` | 等待时长与超时判定（只告警，不自动交回）；未接管时返回 waitedMs:0 | Web 凭证（agent / admin） + CSRF | 200 / 401 / 403 / 404 |
| GET | `/api/handoff/queue` | 单会话部署：depth ∈ {0,1}（审计员只读；坐席动作仍需 agent/admin） | Web 凭证（agent / auditor / admin） | 200 / 401 / 403 / 404 |
| GET | `/operator` | 坐席工作台入口（零注入；static 模式凭证由坐席粘贴，存 sessionStorage） | 无（静态） | 200 / 404 |
| GET / HEAD | `/*` | 静态资源（默认根目录见 §7.2；纯原生 ES 模块，无需构建）；畸形百分号编码 → 400 | 无（静态） | 200 / 400 / 404 |
<!-- web-routes:end -->

重生成：`npx tsx scripts/web-routes.ts`。`web/contract.test.ts` 会把上面这段与生成结果逐字比对，
不一致即红——所以"改了路由忘了同步文档"不会静默通过。

闸的顺序**不可重排**：限流 429 → 管理面（自身 admin token + 回环，豁免 Bearer/CSRF）→
Bearer 401 → CSRF 403 → 业务 423/409 → 静态 404 → 405。状态码列只列该路由自身可能产生的码，
不含 429（逐路由相同）与 500（全局兜底：未归类异常一律 `web-internal`）。

**W09 CSRF**：所有写路由（`POST/PUT/DELETE`）在 Bearer 之后额外校验——同源 `Origin`，
或 `bah_csrf` cookie + `X-BAH-CSRF` 请求头双提交一致；缺失 403 `web-csrf-required`，
不符 403 `web-csrf-forbidden`（详见 §7.2.2）。管理路由豁免（CLI 客户端没有 Origin/cookie）。

### 7.1 管理路由（`POST /api/admin/sentry/unfreeze`）

只有一条，且**默认不存在**：没设 `BAH_ADMIN_TOKEN` 时返回 404（不暴露存在性）。

```json
// 请求
{ "by": "ops-7", "reason": "客服复核：误报" }   // by 必填 ≤64；reason ≤200，缺省 operator-unfreeze

// 响应
{ "ok": true, "unfrozen": true }    // 真解除了
{ "ok": true, "unfrozen": false }   // 本来没冻结（幂等 no-op，不是错误）
```

状态码顺序即安全顺序（**先问"路由存不存在"，再问"你是谁"，最后问"你要干什么"**）：

| 顺序 | 条件 | 状态 | code |
|---|---|---|---|
| 1 | 未设 `BAH_ADMIN_TOKEN`（**任何方法**） | **404** | `web-not-found` |
| 2 | 来源不是本机回环 | 403 | `web-admin-forbidden` |
| 3 | 方法不是 `POST` | 405 | `web-method-not-allowed` |
| 4 | 缺 / 错 `Authorization: Bearer` | 401 | `web-admin-unauthorized` |
| 5 | body 非对象 / 缺 by / 未知键 / 超长 / 坏 JSON | 400 | `web-admin-invalid-body` |
| 6 | profile 没有 `safety:sentry` | 503 | `sentry-absent` |

**404 必须排在 405 前面**：没配 token 时如果 `GET` 返回 405，等于告诉扫描器
"这里有个管理口，只是方法不对"——那就不叫"不暴露存在性"了。

三条硬约束：

- **只绑回环**：`127.0.0.0/8`、`::1`、`::ffff:127.0.0.1`；`0.0.0.0` / `::` 不算；不加 CORS；
- **token 只从环境变量读**：不进 URL、不进 argv、不进日志、不进审计；
- **不加进 `webPlugin.plugin.inject`**：web 是渠道不是风控，没有 sentry 的 profile 也必须能起（此时路由 503）。

CLI 侧对应命令是 `bah sentry unfreeze --by <operator>`（headless 无此入口，只能重启进程，
见 `docs/sentry.md` §5.1）。

### 7.1.1 HALT 管理路由（W07）

三条路由与 §7.1 **共用同一道管理闸**（token / 回环 / POST / 404 优先），
区别只在业务语义：

```json
// POST /api/admin/halt —— reason 写死 manual，body 只允许 detail（≤200，可选）
{ "detail": "值班主管按下停机" }
// → { "ok": true, "halted": true, "changed": true }   // 重复调用 changed:false（幂等）

// POST /api/admin/halt/unfreeze-request —— 在运行中的会话里发起一次 ushield 审批
// → { "ok": true, "ticketId": "ticket:…", "expiresAt": 1792… }   // 审批被拒 → 409

// POST /api/admin/halt/unfreeze —— 凭票据解除；没有 force / 没有无票据路径
{ "ticketId": "ticket:…" }
// → { "ok": true, "halted": false }   // 未知/过期/无 MFA → 400；本来没 HALT → 409
```

HALT 期间新 turn 的 `/api/turn` 返回 **423 `safety-halted`**（不是 500：这不是服务器故障，
是系统被人工停机）。没有 `safety:sentry` 的 profile 三条路由都 503 `halt-absent`；`safety.halt.enabled=false` 时
三条路由都 503 `halt-disabled`（回滚开关不许被伪装成“仍在 HALT / 已解除”）。

### 7.2 Web 凭证（D5 最小集）

三种认证模式（`channel:web.auth.mode`，缺省 `static`）：

| 模式 | 客户 | 坐席 | 页面 |
|---|---|---|---|
| `none` | 无凭证，合成主体 `svc:web` / `customer` | 不可用（不含 agent） | 无登录门 |
| `static` | `BAH_WEB_TOKEN` → `svc:web` / `customer` | `BAH_OPERATOR_TOKEN` → `svc:operator` / `agent` | token 入口注入 token；坐席页零注入 |
| `password` | 登录用户（会话 cookie，角色来自用户目录） | 本轮不开放（D2）：坐席面整条 404 | 注入 `bah-auth-mode` + CSRF cookie，不注入 token |

除 `GET /api/health` 与管理路由外，所有 `/api/*` 要求已认证主体；
缺 / 错凭证一律 401 `web-unauthorized`，角色不足 403 `web-forbidden`；请求不会触达 agent。
坐席工作台（`/operator`）**不是**角色矩阵的一部分：它由 `seatEnabled` 控制存在性，
未启用时 404（不是 401——401 会告诉探测者"这里有东西"）。坐席入口与 5 条坐席 API 的
角色是 `agent` / `admin`；客户专属动作（turn / interrupt / approval / verify）只许 `customer`。

- **token 来源**：`BAH_WEB_TOKEN`；未配置时每个进程启动随机生成（`packages/host/src/boot/plugins/web-auth.ts`），
  不写死、不入库、不进审计。
- **页面载体**：响应 `index.html` 时注入 `<meta name="bah-web-token">`，同源脚本读取后放进请求头。
  跨源页面读不到这个响应体（没有 CORS）——但这是访问凭证，不是登录；CSRF 另有 §7.2.2 的
  双提交校验，不靠"读不到响应体"这条隐式边界。
- **SSE 例外**：`EventSource` 不能设请求头，只有 `GET /api/events` 接受 `?token=`；其余接口不认查询参数。
- **健康探针公开**：编排器与演示脚本只问"还活着吗"，不拿凭证。

约定：

- 全部 JSON 用 `application/json; charset=utf-8`；SSE 用 `text/event-stream`，每 `heartbeatMs`（默认 15s）一条 `: ping` 心跳。
- SSE 只有三种命名事件：`frame`（帧，含 `snapshot`）、`fault`（渠道级故障）、以及浏览器内置的 `open`/`error`。
  自定义事件**不能叫 `error`**，否则会和 `EventSource` 内置错误回调撞名。
- 错误体统一 `{ error: { code, reason } }`，`code` 是结构化理由码（AGENTS.md 编码纪律 5）。
- POST 成功后返回 `{ ok: true, seq? }`，前端不据此改状态（状态只来自帧）。
- 路径参数 `ticketId` 只允许 `[A-Za-z0-9._:-]{1,128}`，防注入到日志/文件名。

#### 7.2.1 审批归属（W04）

有效 token 只证明"能访问这个 Web 服务"，不证明"这张票据归你"。审批/验票两条路由额外校验
票据的 `sessionId` 与渠道绑定会话一致：

| 请求 | 状态码 | 行为 |
|---|---|---|
| 无 / 错误 `Authorization` | 401 | 不触达仲裁器；票据仍 `pending` |
| 有效 token + 他会话票据 | **403** `foreign-ticket` | 不结算、不触达 `answer()` |
| 有效 token + 不存在票据 | **404** `unknown-ticket` | 与 403 同一 `{error:{code,reason}}` 信封，不带金额/工具名/会话 ID |
| 有效 token + 本会话票据 | 200 | 正常结算并落 `approval/decided` |

实现：`ApprovalView.sessionId` → `createWebChannelAdapter({ sessionId })` → 适配器在
`decide` / `verify` 入口比对；`web.ts` 只做状态码翻译（`foreign-ticket` → 403）。
单会话宿主里正常的跨会话票据不会进入待应答表（404 兜底），403 是给"多会话 / 错误装配"预备的防线。

#### 7.2.2 CSRF（W09）

写请求（`POST/PUT/DELETE`）在凭证检查之后、业务处理之前过 CSRF 闸：

| 请求形态 | 结果 |
|---|---|
| `Origin` 与请求 `Host` 同源 | 放行 |
| `Origin` 跨站（如 `https://evil.example`） | 403 `web-csrf-forbidden`（即使带了令牌） |
| 无 `Origin`，但 `bah_csrf` cookie 与 `X-BAH-CSRF` 头都存在、相等、且等于本进程令牌 | 放行（double-submit） |
| 无 `Origin`、也无 cookie/头 | 403 `web-csrf-required` |
| cookie 与头只有其一，或值不等/不等于本进程令牌 | 403 `web-csrf-forbidden` |

- **cookie 下发**：`GET /`（index.html）响应带 `Set-Cookie: bah_csrf=<随机>; Path=/; SameSite=Strict`，
  **不是 HttpOnly**——double-submit 需要同源脚本读取；页面 `no-store`，重启换 token 不会读到旧的。
- **前端同批改造**：`apps/web/src/transport.js` 的 `createHttpApi` 在非 GET 请求里回填
  `x-bah-csrf`；没有 cookie 时不伪造（让服务端 403 兜底，而不是前端假装成功）。
- **豁免**：`/api/admin/*` 使用自己的 admin token + 回环绑定，CLI 没有 Origin/cookie；SSE 是 GET，
  不受影响。`web.csrf.enabled=false` 是回滚开关，关掉必须在自评报告登记。
- **顺序**：限流 → 管理路由 → Bearer（401）→ CSRF（403）→ 业务（HALT 的 423 仍由 `agent.send` 产生）。
  这样缺凭证不会被 CSRF 抢成 403，也不会把停机状态误报成跨站攻击。

---

### 7.3 观测面板

第三个 tab「观测」（`#tab-observe` / `#panel-observe`），默认不显示，点开才开始轮询。

三条视图：

1. **四张 KPI**：轮次 / 工具错误率 / 工具 p95 / 成本；
2. **SLO 八行表**：值 + soft / hard + 判决（判决由服务端给，前端不重算阈值）；
3. **轨迹瀑布**：当前会话的 span 森林，按开始时间排；点击一行展开属性，再点收起。

取数策略（**拉取式**，不新增 SSE 帧）：

- 仅在「观测」tab 且 `document.visibilityState === 'visible'` 时轮询；
- 成功 2s 一次；失败按 2/2/4/8/16/30s 退避，成功即复位；单次 3s 超时；
- 同一时刻最多 1 个在途请求（`setTimeout` 链，不用 `setInterval`）；
- 连续 3 次失败显示「数据陈旧 Ns」+ 手动刷新按钮（手动刷新 ≥1s 节流）。

空态三态：

- **未连接**：`观测面板需要连接后可读` + 重试按钮；
- **无数据**：`本会话还没有结束的轮次`；
- **端点失败**：`指标读取失败（<code>）` + 重试按钮，保留上一次的数字不闪空。

三条口径纪律（与 `/api/metrics` 的 null 语义一致）：

- `p95 === null` 显示「无样本」，**不显示 0ms**；
- `slo === null` 表示本 profile 未装配 saga，整表空态，**不渲染 0**；
- `cost.configured === false` 表示本地 provider 无上游账单，**不显示"免费"**。

---

## 8. Session-follow

```text
connect: GET /api/events?since=<clientMaxSeq>
  └─ 任何 since → snapshot（服务端当前全量帧）+ 后续增量帧
```

**实现说明**：`since` 仍然校验（非负整数）并用于日志与将来优化，但服务端**总是发全量快照**。
理由：帧是纯数据，全量替换比"补发若干条"少一条会错的路径；客户端按 `seq` 过滤重复帧，
所以"重连时 since 已过期"不会造成半新半旧。

- **不丢**：服务端先取 `session.events()` 快照（含 `lastSeq`），再挂 `session/event` 监听；两者之间的事件按 `seq > lastSeq` 去重。
- **不重**：客户端 `maxSeq` 单调推进，`seq <= maxSeq` 的帧直接丢弃；`snapshot` 整体替换。
- **溢出**：客户端缓冲上限 `followBufferLimit`（默认 512 帧），溢出即丢弃本地并重连 `since=0`（全量重同步）。
- 断线：`EventSource` 自带重连，但**重连参数不会更新**，因此用 `last-event-id` + 手动 `close()/new EventSource`（1s 退避，最多 10 次）保证续订点正确。

> T-WEB-001 的核心断言就在这里：给定 1..20 条事件、客户端已在 12，重连后收到的帧集合必须恰为 13..20。

---

## 9. 插件接入（"前端作为插件模块"）

### 9.1 插件行

```yaml
- id: channel:web
  use: channel:web
  config:
    port: 7331
    host: 127.0.0.1
    staticRoot: apps/web
    followBufferLimit: 512
    heartbeatMs: 15000
```

- 插件 id 与内核插件同构（`domain:name`），配置逐键校验（`rejectUnknownKeys` + 类型读取），未知键即启动失败。
- `inject: ['bah:run', 'runtime:session', 'runtime:agents', 'interaction:approval']`——缺审批服务即挂起，不静默降级。
- 端口占用 → `BahError('web-listen-failed')`，不自动换端口（换端口会让"答辩时打开的是旧页面"变成可能）。
- `port: 0` 合法：由内核分配随机端口，测试与桌面壳内嵌用；实际端口经 `WEB_SERVER` 服务（`channel:web`）暴露。

### 9.2 启动

```bash
pnpm web          # = tsx packages/cli/src/main.ts --profile web --serve
```

- `--serve` 是**渠道无关**的 CLI 语义："启动 profile 并常驻，直到 SIGINT/SIGTERM"。CLI 里没有 `if (profile === 'web')`。

### 9.3 服务键

| 键 | 形状 | 用途 |
|---|---|---|
| `channel:web` | `{ port, url, sessionId }` | 渠道已就绪的证明；测试用 `port: 0` 拿随机端口；桌面壳内嵌时拿地址 |
- `profiles/web/patch.yml` 复用 headless 的 mock 模型脚本（三幕演示），只把 `interaction:approval.responder` 设成 `none`（等人点，不自动放行）。

### 9.4 审批应答者

- 插件在 `apply` 时 `approval.attach(webResponder)`，`attach(view)` 只把 `view` 推进 SSE 广播队列，**立即返回**；真正结论来自 `POST /api/approval/:ticketId`。
- 插件 `dispose` 时注销应答者：在途审批归一化为 `cancelled`（默认拒绝方向）。

---

## 10. 测试矩阵

| ID | 用例 | 文件 | 断言要点 |
|---|---|---|---|
| T-WEB-001 | `seq` 续订 | `packages/channels/src/web/follow.test.ts` | 12 → 20 只补 13..20；重复喂 15 不产生新帧 |
| T-WEB-002 | 卡片三态 | `apps/web/src/views/tool-card.test.js` | 同一 `callId` 三次更新 = 3 个状态、1 个节点 |
| T-WEB-003 | 审批六要素 | `apps/web/src/views/approval.test.js` | 六个字段齐、缺金额显示"待确认"；同轮成功预演一致 → 已确认 |
| T-WEB-004 | 审批超时 | `apps/web/src/views/approval.test.js` | `unavailable` → "未执行"，按钮禁用 |
| T-WEB-005 | 金额降级 | `channels/web/amount.test.ts` + `tool-card.test.js` | 无结果 → `confirmed=false` + "待确认"；成功预演且收款人/金额一致 → `true` |
| T-WEB-006 | DAG blocked | `apps/web/src/views/dag.test.js` | 失败节点下游 `data-blocked="true"` |
| T-WEB-007 | presenter 纯函数 | `channels/web/project.test.ts` | 两次运行深度相等 + 显式期望 |
| T-WEB-008 | 独立运行 | `apps/web/src/main.test.js` | 无桌面壳时五视图挂载成功 |
| T-WEB-009 | 协议拒绝 | `packages/host/src/boot/plugins/web.test.ts` | 空文本 400、未知票据 404、非法 ID 400、方法 405 |
| T-WEB-010 | 渠道不扰动事件流 | `snapshots/web-channel/` | 接上 `channel:web` 后录制/回放逐条全等（含审批与票据生命周期） |
| T-WEB-011 | 真实日志回归 | `channels/web/snapshot.test.ts` | 用 `snapshots/web-channel/session.jsonl` 投影：金额 `¥800.00`（元口径）、领域事件不炸、两次投影相等 |

门禁：

- `verify-web`：① `apps/web` 无框架依赖；② 无远程资源（`http(s)://` 出现在 `src/href/url()`）；③ `styles/ds/*` 与 `design/bah-ds/*` 哈希一致；④ `app.css` 无裸色值。
- `verify-visual-line`：视觉口径的自研不变量——`design/` 下只能有 `bah-ds` 一个基线目录；全仓的基线路径引用只能是 `design/bah-ds`；命名面文档里的视觉系统自称只能是 BAH DS；锚点文件缺声明即红。判据用正向不变量而非禁用词清单，且必须报出实际扫描文件数（防止"没扫到"被当成绿）。
- 既有门禁不变：`no-upstream-imports`、`verify-plugin-config`（新行必须在 `HOST_PLUGINS`）、`verify-event-modes`（不新增全局事件）。
- `snapshot-fresh`：`channel:web` 属 `host/boot/` 敏感面，新增场景 `web-channel` 由真实重录背书（不是靠 `BAH_ALLOW_NO_SNAPSHOT` 放行）。

---

## 11. 偏差登记

| 编号 | 偏差 | 原因 | 回收条件 |
|---|---|---|---|
| R-WEB-D1 | DAG 从工具调用派生，非 `plan/*` 事件 | 施工单 14 未开工，`plan/*` 事件表不存在 | `plan/*` 落地后替换数据源 |
| R-WEB-D2 | "回到上一步"（fork）未接 | fork 产生**新会话**，单会话服务端需切换会话与 SSE 重连，属施工单 14 §5 范围 | 施工单 14 落地 |
| R-WEB-D3 | 坐席接管视图未接 | 无 `handoff/*` 事件；属施工单 15 | 施工单 15 落地 |
| R-WEB-D4 | 流式 `delta` 为 ephemeral，不入会话日志 | 分片不是事实，`assistant/message` 才是；落账分片会让日志膨胀且破坏 `deriveMessages` | 永不回收（设计选择） |
| R-WEB-D5 | 依赖方向 `host → channels` 翻转 | 见 §3 | 不回收（修正） |
| R-WEB-D6 | 卡片从 `tool/call.args` + `tool/result.content` 派生，非 `UiCard` | `UiCard` 不落账（`ToolPipeline` 算出后无人持久化），回放场景无 `kind` 可用 | `tool/call` 增 `card` 字段后换 `cards.ts` 输入 |
| R-WEB-D7 | 渠道适配器未实现 `answerApproval`（改由 `attachApproval` + `decide`） | 人点按钮是**带外**事件，不是同步返回值；施工单 09 的 `ApprovalResponder` 才是权威接缝 | 不回收（修正） |
| R-WEB-D8 | 审批弹窗无倒计时，只有"已等待" | `approval/asked` 不带票据 TTL（`ApprovalView` 也不暴露 `expiresAt`）；编倒计时=在资金操作上说假话 | `approval/asked` 增 `expiresAt` 字段（需事件表变更 + 重录快照） |
| R-WEB-D9 | 金额单位在运行时口径不一致 | `TicketDraft.amount` 注释写"金额分档"、pipeline 用例传 `50_000`，而 bank governance 实际填 `amountCents / 100`（**元**） | 渠道以**参数金额（元）为准**，事件金额按元兜底；建议后续统一口径并更名 |
| R-WEB-F1 | `channels/web/` 未进覆盖率强制名单 | 名单扩容会牵动 `pnpm test:coverage` 阈值，且 `apps/web` 是 JS 不在 v8 include 面 | 随施工单 14 一并扩容（本次已落 53 条投影用例 + 46 条前端用例 + 13 条宿主用例） |

---

## 12. 施工步骤（勾选表）

- [x] 1. 依赖翻转 + `@bah/channels` 入口
- [x] 2. 帧模型与投影器（`frames.ts` / `project.ts`）
- [x] 3. 金额降级（`amount.ts`）
- [x] 4. 卡片模板（`cards.ts`）
- [x] 5. 审批六要素（`approval.ts`）
- [x] 6. DAG（`dag.ts`）
- [x] 7. 审计时间线（`audit.ts`）
- [x] 8. Session-follow（`follow.ts`）
- [x] 9. `ChannelAdapter`（`adapter.ts`）
- [x] 10. `channel:web` 宿主插件（HTTP/SSE/应答者）
- [x] 11. `apps/web` 五视图 + 令牌副本
- [x] 12. `verify-web` 门禁 + web profile + `--serve`
- [x] 13. 全量验收（typecheck / test / test:web / gate / lint）

---

## 13. 产物清单

| 层 | 文件 | 行数量级 |
|---|---|---|
| 投影（TS） | `packages/channels/src/web/{frames,project,amount,format,cards,audit,dag,follow,adapter,index}.ts` | ~1.4k |
| 宿主（TS） | `packages/host/src/boot/plugins/web.ts` | ~430 |
| 前端（JS） | `apps/web/src/{main,store,transport,dom}.js` + `views/{conversation,tool-card,approval,dag,audit}.js` | ~1.5k |
| 样式 | `apps/web/styles/app.css` + `styles/ds/*`（令牌副本） | ~800 |
| 装配 | `profiles/web/{profile,patch}.yml`、`channel:web` 插件行、`pnpm web`、CLI `--serve` | — |
| 用例 | `channels/web/*.test.ts`（53 条，含真实日志回归） + `apps/web/**/*.test.js`（46 条） + `web.test.ts`（13 条） + `snapshots/web-channel` | 112 |
| 门禁 | `scripts/verify-web.ts`（框架依赖 / 远程资源 / 令牌同步 / 裸色值 / 图标存在） | ~180 |
