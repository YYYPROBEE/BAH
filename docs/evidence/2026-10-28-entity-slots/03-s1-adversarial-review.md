# S1 对抗式复审（ES-10 … ES-19，运行时契约层 · 行为保持）

> 复审时间：2026-10-28 14:48–14:55 +0800
> 基线 HEAD：`448f061`（S0 + 台账挪动已入库）
> 结论：**可提交**。门禁 36/36、typecheck 绿、旧快照逐字全等。
> 附 3 条前向风险（F5–F7），均已指定收口阶段。

---

## 1. 改动清单（14 文件，+599 / −65）

| 文件 | 改动 |
|---|---|
| `system-prompt/types.ts` | 视图 v2：`RuntimeContextAccountView`（`balanceText` / `availableText` / `statusText`）+ `meta` |
| `system-prompt/sections.ts` | 渲染器双路径；**删除 `formatMoney`**；抽出 `accountLine` / `asOfClause` |
| `system-prompt/port.ts` | 新增：`RuntimeContextInvocation` / `Resolution` / `Source` + `RUNTIME_CONTEXT_SOURCE` + `ContextSlotsEventData` |
| `system-prompt/index.ts` | 导出 port |
| `agent-loop/agent.ts` | `RuntimeContextProvider`（可异步）；`step()` 的 await / abort 复查 / 失败边界；`context/slots` 落账 |
| `sections.test.ts` | 静态逐字 / bank 三态 / 首行前缀 / 金额原样（22 例） |
| `agent.test.ts` | 7 例：调用参数、每 step 现算、挂起中断、抛错、事件 PII、静态无事件、fork |
| `registry.test.ts` / `reconcile.test.ts` | 夹具适配 `balanceText`（断言逻辑不变） |
| `docs/facts-sources.md`、`facts.md`、`README.md`、`docs/{deploy,testing,security-self-assessment}.md` | 用例数 2115 → **2131**（派生同批） |
| `snapshots/{compaction,headless-basic,web-channel,sandbox-compute}/reverified.json` | 摘要更新（回放全绿才写；`plan` 未变） |

---

## 2. A 角度（验收 / 契约）

| # | 判据 | 取证 | 结论 |
|---|---|---|---|
| A1 | `balance: number` 消失 | `grep -rn "balance: number" packages/*/src` → 0 | ✅ |
| A2 | `formatMoney` 消失 | `grep -rn "formatMoney" packages/*/src scripts` → 0；仓内零消费者 | ✅ |
| A3 | 端口可被解析 | `npx tsc -b tsconfig.host.json tsconfig.client.json` → 退出 0 | ✅ |
| A4 | invocation 六字段齐 | 单测断言 sessionId / turn / step / forkOf / now；`signal` 由类型保证 | ✅ |
| A5 | await + abort 复查 + 错误边界 | 挂起中断用例：无 `request/header`/`system/message`/`request/context`，`turn/end=aborted` | ✅ |
| A6 | 静态输出逐字不变 | `pnpm test:snapshot` 6/23 全绿，`git status snapshots/` 零 diff | ✅ |
| A7 | 首行恒 `【当前用户】` | 三态单测 + 跨包 `PLATFORM_CONTEXT_PREFIX` 钉（4 个视图全覆盖） | ✅ |
| A8 | 事件只在 bank 视图落 | 静态视图 0 条；bank 视图 1 条且形状精确 | ✅ |
| A9 | 数量口径 | 205 文件不变；2115 → 2131 例；门禁 36 | ✅ |
| A10 | 生产 profile 未动 | `git diff --stat` 无 `profiles/`；无生产代码构造 `accounts` | ✅ |

---

## 3. B 角度（对抗 / 回归）

### B1 最强证据：步进时钟下的零 diff

快照场景的时钟是**步进**的（`scenario.json: clock.step = 1`）：每次 `now()` 调用都会让下一条事件的
`at` 前进 1ms。若解析改造让静态路径多取一次钟、或 `await` 改变了事件顺序，5 个场景的
`session.jsonl` 必然整体漂移。

实测：`pnpm test:snapshot` **6 文件 / 23 例全绿，快照零 diff**。
⇒ 同时证明了三件事：① 静态路径没多走一格钟；② `await` 未改变事件顺序；③ 渲染器静态分支逐字未变。

### B2 负控 1：把 degraded 首行改坏（ES-16 要求）

临时改成 `【画像不可用】slots-timeout；…`，跑 `sections.test.ts`：

```
× degraded：带稳定理由码，提示改用工具查询
  → expected '【画像不可用】slots-timeout；…' to contain '【当前用户】画像不可用（…）'
× degraded 没有码时降级为 unknown
× bank 三态首行都是【当前用户】
× 环境段前缀与 llm 的判定常量一致     ← 跨包钉也红了
Tests  4 failed | 18 passed (22)
```

**四条同时红**（含跨包常量钉），证明这条不变量不是"写着好看"。已改回，复跑 130 例绿。

### B3 负控 2：给事件塞姓名

临时把 `leakedName: runtime.user.name` 加进 `context/slots` payload：

```
× bank 视图 → 落 context/slots 事件，payload 不含 PII
  → expected { source: 'bank', status: 'ok', …(4) } to deeply equal { …(3) }
Tests  1 failed
```

精确形状断言先抓住多余键（早于 PII 子串断言），说明"只记计数"是被钉住的。已改回。

### B4 `context/slots` 不污染平台事件表

- `grep -rn "context/slots" packages/*/src` 只命中 `port.ts` 与 `agent.ts`（注释 + 落账点），**未进**
  `SESSION_EVENT_TYPES` / `SessionEventMap`；
- reader 行为：`session/derive.ts:90` —— 未知事件 `ignorable === true` 直接 `continue`；
  只有"未知且非 ignorable"才抛（`:93`）。我们落账时显式 `{ ignorable: true }`。
- `verify-session-events` 门禁 36/36 通过（走 `appendDomain`，无需登记）。

### B5 fork 安全（I12）

单测：`fork()` 后子 loop 跑一轮，provider 收到 `sessionId = 's-forked'`、`forkOf = 父会话`。
实现上 `fork()` 继续传同一个函数（闭包不取会话），会话身份由 `step()` 现造——与方案 §5.2 一致。

### B6 删除公共 helper 的影响面

`formatMoney` 是 `@bah/runtime` 的辅助函数级导出（`system-prompt/index.ts` 的 `export *`），
**不在 `core/api.ts` 冻结面**；仓内零生产调用（唯一引用是它自己的测试）。`packages/*/dist` 未入库
（`git ls-files packages/runtime/dist` 为空），不存在陈旧声明被打包的风险。

### B7 尝试证伪但未成立的假设

| 假设 | 取证 | 结果 |
|---|---|---|
| "静态路径会多取一次钟" | 步进时钟快照零 diff（B1） | 未成立 |
| "await 会打乱事件顺序" | 同上 | 未成立 |
| "域事件会让 derive 抛 required-on-read" | `derive.ts:90` + 全量 2131 例绿 | 未成立 |
| "host 会因视图类型变更编译失败" | typecheck 退出 0 | 未成立 |
| "profile 里有人写了 meta" | `grep -rn "meta:" profiles/` → 0 | 未成立 |

---

## 4. 复审结论与前向风险

**阻断项 0。** 三条前向风险：

| # | 级别 | 内容 | 收口 |
|---|---|---|---|
| F5 | P2 | `host/src/boot/plugins/agent.ts` 把 `config['runtimeContext']` **直接断言**成 `RuntimeContextView`；若 profile 误写 `meta`，会静默走 bank 路径（等于绕过 `slots.source` 开关） | S3 配置校验必须**禁止静态 profile 写 `meta`** |
| F6 | P2 | 解析失败时 `failed()` 会把异常 message 原文写进 `assistant/attempt.reason`（落盘）。若适配器把含卡号/姓名的核心错误直接 throw，就会把 PII 写进会话日志 | S2 适配器纪律：**业务失败返回 degraded 码，绝不 throw 带业务信息的错误** |
| F7 | P3 | 对外材料（roadmap / judge-walkthrough）仍按"静态"口径描述，与"端口已就位"存在时差 | S5 统一改写；在此之前**不得**宣称"实体槽位已通电" |

**数字口径**
- 用例 205 文件 / **2131** 例（+16；无新增测试文件）；
- 断言 6707 → **6763**：`verify-assertions` 的语义是"只防下降"，增长不要求 `--update`，未动基线；
- 快照 6 / 23 不变；门禁 36；工具 16。

**对外不许讲的话**
1. 不许讲"实体槽位已通电"——S2 适配器、S3 装配都还没做，生产路径仍只读 profile 静态画像；
2. 不许讲"模型现在能看到账户与流水"——当前只是契约层就位；
3. 可以讲"实体槽位的运行时契约（视图 v2 + 端口 + 异步解析 + 无 PII 事件）已就位，且静态路径逐字不变"。
