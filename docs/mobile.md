# 移动 H5 与跨场景

> 先读这一段：本页所有"能力"都标了**是演示级还是已实现**。
> 数字一律以 `facts.md` / `docs/facts-sources.md` 为准，本页只写口径，不抄常数。

## 1. 它是什么

- **移动 H5 演示壳**：`apps/web/m.html` + `apps/web/src/mobile/`（纯原生 ES 模块，Vite 只用于开发）。
- **与桌面壳同源**：与 web（7331）共用同一份 `createHttpChannel`——路由、闸序（限流 → Bearer → CSRF → 业务）、
  安全头、审批/验证端点逐字相同；差异只有三处（能力位、入口 HTML、默认端口，见 `profiles/mobile/profile.yml`）。
- **端口 7551**：显式配置；**被占即启动失败**（`web-listen-failed`），绝不自动换端口——
  "看起来能用"比打不开更危险。

```bash
pnpm bah --profile mobile --serve
# 浏览器 DevTools → 设备模拟 → http://127.0.0.1:7551/m.html
```

## 2. 四幕演示与代码落点

| 幕 | 用户看到什么 | 真实发生的代码 |
|----|-------------|---------------|
| 一 · 对话式办业务 | 查余额直答 | demo router（确定性路由）→ `account_balance` |
| 二 · 模糊复现 | 系统反问而不是猜 | `intent_resolve`（可解释规则）→ `prompt_ask` → `choice` 帧 |
| 三 · 跨场景提案 | 提案卡 + 6 步清单 + 逐笔审批 | `goal_set` → `plan_propose` → `plan_execute` → 每节点各自 `transfer_preview`/`transfer_create` |
| 四 · 中断与接管 | 已发生清单、接管横幅、"回到上一步" | `POST /api/interrupt` / `POST /api/handoff` / `POST /api/session/fork` |

离线演示**不配任何密钥**：`provider: router` 是仓库自带的确定性路由模型，**自称"不是自然语言理解"**
（`packages/llm/src/demo/router.ts` 头注释）。真实模型接入不在本轮范围。

## 3. 诚实边界（逐字口径，对外材料照抄）

### 3.1 定时 = 真授权窗口（2026-11-01 起不再是预演）

> 移动端与 web 主演示都已装配 `plan:dag` + `plan:scheduler` + `fact:store` + `bank:merchant`。
> "生日前 2 天自动下单"由 `birthday_plan` 建**三张授权窗口**（锁预算 / 鲜花 / 蛋糕），到期由
> `plan_wake` 先复验条件（余额、事实版本、明细摘要）再执行；任一条件失守立即**降级回人工**，不自动扣款。
> 调度复用 `saga/tick` 与启动补跑，**没有**独立的 `@bah/schedule` 包；`transfer_create.when` 仍只接受
> `now`（定时一律走 `transfer_schedule`，防止绕过窗口直接定时扣款）。
> **边界**：演示进程要等真实时间推进（或用注入钟）；商户是 mock 目录，不存在真实履约/退款通道。

### 3.2 人工接管

> "人工接管状态保存在**进程内**（`HandoffRegistry`），服务重启后回到 `active`（未接管）状态——这与 HALT 熔断
> （有持久化 unfreeze 流程）不同。本演示的'人工接管'是**单机演示级**能力：它不是坐席工作台，没有排队、技能路由、
> 回交工单、SLA 计时。`handoff/requested`/`handoff/resumed` 两个事件经 `appendDomain` 写入且标记 `ignorable`，
> 不在事件表 v1.0.1 冻结键清单内。"

接管期 `/api/turn` **202 落账但不驱动模型**（消息会出现在会话流里，等坐席处理）；`/api/session/fork` 409。
交回必须是一次真实的状态转移（未接管时交回也是 409），且只能由**坐席工作台**发起：
`POST /api/handoff/resume` 认坐席凭证，移动渠道按部署纪律不配 `BAH_OPERATOR_TOKEN` ⇒ 移动壳
**不渲染"恢复"按钮**（渲染了也只会得到 404，2026-10-29 走查 P1-1）。

### 3.3 回退 = 分叉

> "'回到上一步'是分叉新会话，旧会话封存为审计证据；不存在'撤销已发生操作'的能力。"

HTTP 入口 `POST /api/session/fork` 消费既有 `forkSession()`：旧会话**一个字节不改**，
新会话以 `forkOf` 指向旧会话、以 `seedLength` 标记继承的事件前缀长度。

**已知限制（如实登记）**：分叉会话在**本进程内**存在（前缀已恢复），但当前 HTTP 渠道仍服务原会话——
"把渠道切到新会话"属于多会话宿主，**未实现**。所以移动壳上的"回到上一步"目前表现为
"已从第 N 步分叉，原会话保留可查"的提示，而不是切换对话流。

### 3.4 资金与商户

> "全部资金操作由仿真核心（MockBankCore）处理，未对接任何真实银行系统。"
> "鲜花/蛋糕商户为仿真种子数据，非真实商户通道。"

生日案例的三笔转账（锁定预算 300 / 鲜花 200 / 蛋糕 100，合计 600 元）都走既有 `transfer_create`，
**没有新增任何银行工具**。"锁定"是内部划转到一个 `locked` 类型子账户：**单向 earmark**
（活期 → 锁定/定期），锁定账户不能作转出方；解锁/支取属真实核心的产品能力，未仿真。
日限额沿用数据集默认的 1000 元（三笔合计 600 元，全链黄级）——**升红规则与部署口径都没有为演示改过**，
移动与 web 的业务配置段保持逐字一致（门禁 I8）。

### 3.5 移动壳

> "移动 H5 为浏览器演示壳，未做原生打包、未接真实推送渠道（无 Service Worker）。"

## 4. 三帧与两平面（给后续维护者）

- `goal`：会话级意图账本，`goal_set` 绿级工具，落账只经 `tool/call` + `tool/result`（零新事件键）。
  进程内 Map；因结果已落账，重启后可由 `replayGoalStore(sessionEvents)` 重建。**不宣称有数据库。**
- `todo`：plan 事件的**投影**（`deriveTodos` 复用 `replayPlan`，同源同序），不落账、不读时钟；
  中断窗口里没落 per-node 事件的剩余节点显示"已取消"，不显示"排队中"。
- `effects`：已成功的写操作清单（中断时告诉用户"钱去哪了"），`rollback: false` 是常量——**不回滚**。

`plan_execute` 只批准"开始执行这张图"；每个写节点仍是**独立的黄级审批 + 一次性票据核销**。
门禁 `verify-cross-scene` 的 I4 用 `snapshots/cross-scene/` 的事件序做动态判定：每个 succeeded 的
`transfer_create` 节点都必须有自己的审批记录。

## 5. 相关命令

```bash
pnpm bah --profile mobile --dump-config   # 打印装配（不监听端口）
pnpm test:web                             # 移动壳与投影用例
pnpm test:snapshot                        # 含 snapshots/cross-scene
pnpm gate                                 # 含 verify-channel-capabilities / verify-mobile-shell / verify-cross-scene
```
