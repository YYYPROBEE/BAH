# 测试地基（Testing）

> 适用：底座阶段 2 起。规格依据：施工单 00 §9（纪律）、01 §5–§7（测试面 / 门禁 / 覆盖率）、
> 12 §3（快照回放）。本文件是**操作手册**：改一行代码该跑哪条命令、新用例该怎么写。

## 1. 四个测试面（一个都不能省）

| 面 | 命令 | 配置 | 装什么 | 现状（2026-10-29 实测） |
|---|---|---|---|---|
| unit / 集成 | `pnpm test` | `vitest.config.ts` | 纯函数内核 + 接缝集成（真 Context，不 mock 内核） | 302 文件 / 3494 用例（含 `apps/desktop/src`、`apps/im-gateway`） |
| e2e | `pnpm test:e2e` | `vitest.e2e.config.ts` | **真实 LLM API**（`*.e2e.test.ts`，端点与模型可配，见 §7.1） | 无 `DEEPSEEK_API_KEY` 时零收集（**设计如此**，见 §7） |
| snapshot | `pnpm test:snapshot` | `vitest.snapshot.config.ts` | `snapshots/**/*.test.ts`，**无密钥回放**（录制需显式开关） | 9 文件 / 39 用例 |
| web | `pnpm test:web` | `vitest.web.config.ts` | `apps/web/src/**/*.test.js`，jsdom | 前端 27 文件 / 375 用例 |

意图/追问平面（03 单）在前两个面里各占一块：`packages/runtime/src/intent/*.test.ts`（规则引擎、
槽位归一化、脱敏、检索闸门、工具 fail-loud）、`packages/interaction/src/prompt/*.test.ts`
（候选去重/排序/上限/手动出口/追问上限）、`scripts/intent-determinism.test.ts`（门禁正反夹具）、
`scripts/cross-scene-gate.test.ts`（跨场景门禁的正反夹具：todo 落账 / goal 新键 / addNode / 批量放行 / 重跑 succeeded）、
`packages/channels/src/web/project.choice.test.ts`（`prompt_ask` → `choice` 帧投影）。

一条命令跑全链（本地等价 CI，fail-fast）：

```powershell
cd D:\项目集\微众杯银行ai智能体\BAH\MonoRepo
pnpm check
```

`pnpm check` 共 **14 步**，任一步红即停并给出耗时汇总：

```
typecheck → lint → build → test → test:coverage → test:coverage:all → gate
          → eval:unit → eval:smoke → eval:baseline → e2e → snapshot → web → rag:check
```

其中 `test:coverage` 与 `test:coverage:all` **两步都要**：前者守「名单内逐文件 100%」，
后者报「行口径（仅 `packages/*/src`）/ 包口径 14–16」。只跑前者会把分母当成全仓——那正是底座评审的红灯。

两种模式，**红绿口径不同，不可混用**：

| 命令 | 未执行面（如无 key 的 e2e） | 用途 |
|---|---|---|
| `pnpm check` | 记为 SKIP，**退出码 0** | 本地开发 |
| `pnpm check:ci` | **退出码 1**（严格模式不接受 SKIP） | CI 必需检查 |

> 为什么不叫 `pnpm ci`：`ci` 是 pnpm 内建命令（`ERR_PNPM_CI_NOT_IMPLEMENTED`），脚本名会被它占掉。
>
> 为什么严格模式用 `--ci` 而不是 `CI=true` 环境变量：`CI=true` 还会强制要求显式 `BAH_SNAPSHOT_BASE`
> （见 `resolveSnapshotBase`），本地没有该变量时会一步都跑不到、直接退出，
> 于是"无 key 即红"这条语义根本得不到验证。两者职责不同。

### 1.1 移动壳（`apps/web/src/mobile/`，施工单 02）

| 项 | 值 |
|---|---|
| 测试面 | `vitest.web.config.ts`（jsdom），`apps/web/src/mobile/**/*.test.js` |
| 规模 | **前端 10 文件 / 194 用例**（含 `test:web` 全量 27 文件 / 375 用例） |
| 覆盖率 | **不在覆盖率面**（`00 §6.1`：前端 jsdom 用例不计入 `packages/*/src` 分母），但计入 `test:web` 用例地板（`scripts/ci.ts` 的 `minCases`） |
| 门禁 | `scripts/verify-mobile-shell.ts`（11 条不变量）；负控演练 27 条见 `docs/evidence/2026-10-28-mobile-h5/02-gate-negative-controls.txt` |

**桩纪律（比别的面更严，因为 jsdom 缺失的能力多）**：

1. **桩只能待在 `.test.js` 里**。生产代码的注入点一律是可选的 `deps` / `opts` 参数，缺省走真实浏览器 API
   ——`createMobileShell(deps)` 不传 `api` / `connect` 时就是 `createHttpApi()` + `connectEvents()`。
2. **决策与 DOM 分离**。手势的全部判定在 `reducePointerEvents(samples, config)` 纯函数里；
   jsdom 没有 `PointerEvent` 构造器也能覆盖"滑到 95% 又回拉再松手"这类全路径。
3. **时钟与随机必须注入**。`vi.useFakeTimers()` + `deps.clock`；退避抖动用 `tuning.random` 固定。
4. **不要用 `vi.runAllTimersAsync()`**：抽屉的倒计时是 `setInterval`，永远到期，"跑完所有定时器"没有终点；
   只冲微任务用 `await Promise.resolve()` 循环，推进时间用 `vi.advanceTimersByTime(ms)`。
5. **`fileURLToPath(new URL(..., import.meta.url))` 在 jsdom 环境下拿不到 file 协议基址**，
   读源文件做字面量断言时用 `import.meta.dirname`（与 `scripts/gates.smoke.test.ts` 同款）。

**双口径提醒**：`pnpm test:web` 只跑前端，`pnpm test` 只跑 `packages/*/src` + `scripts/**`——
两个分母互不包含；把任一输出当成"全仓用例数"都会把数字说小或说大。

## 2. 用例命名纪律（硬性）

1. 施工单 §10 给了用例 ID 的，**ID 必须与该表逐字一致**，编号不得增删改，期望值逐条对应。
   例：`it('T-CORE-007 handler 不调 next() → 拥有判决，后续 handler 不执行', …)`。
2. 规格没有 ID 的补充用例，**不带 ID**，名字直接描述行为（覆盖率补丁用例就是这一类）。
3. 测试文件与被测文件同目录（`src/foo.ts` ↔ `src/foo.test.ts`），不分 `test/` 目录。
4. 用例只通过**公开 API** 验证行为；不测私有字段（否则 100% 覆盖率会逼出无意义测试，施工单 02 §12）。

## 3. 覆盖率政策（W17 起：**两个口径，都要报**）

> 底座评审的红灯不是"覆盖率低"，而是**分母只算了一半源码行**。所以从 W17 起有两个口径，
> 谁也不能替代谁；提覆盖率时**必须带口径标签**，否则 W20 的抽查判不合格。

| 口径 | 定义 | 目标 | 命令 |
|---|---|---|---|
| **行口径**（主指标） | `packages/*/src/**/*.ts` 全量分母下，被覆盖的可执行行占比 | **≥ 80%** | `pnpm test:coverage:all` |
| **包口径**（副指标） | 包级行覆盖 ≥80% 的**包数** / 参与统计的包数 | **≥ 14/16（≈85%）** | 同上（同一份报表） |

- 两份配置分工：`vitest.config.ts` 只管**强制 100% 名单**（`scripts/coverage-allowlist.ts`，
  逐文件 100%/100%/100%、分支 80%）——它回答"确定性组件可不可信"；
  `vitest.coverage.config.ts` 只管**全仓分母**——它回答"整个代码库测了多少"。
  后者的 `exclude` **从前者 import**，不复制，保证两份口径排除的是同一批文件。
- **判据只在 `scripts/coverage-summary.ts` 里**（vitest 表达不了"几个包达标"）：
  它打印 `覆盖行数 / 参与统计行数 / 行口径% / 包口径 N/M / 源码物理行数`，
  低于目标即退出码 1。报表在 `.ci-artifacts/cov-all/coverage-summary.json`。
- **既有阈值不许下调**：已在 allowlist 里的文件维持逐文件 100%；新增进名单的首期允许 ≥90%，
  但必须在 `coverage-allowlist.ts` 的 `why` 里写明提升期限。下调阈值属于宪法变更。
- **第 4 批明确不做**：`eval`（53.20%，主体是评测 harness 的场景装载）**不进**本轮目标；
  `memory-store` 已随补测升到 89.40%，不再属于放弃项。这是**显式放弃的项目**，不是漏做——写在这里是为了
  让"80%/85%"这两个数可复现，而不是靠慢慢缩分母。
- 现状（2026-10-29 实测，2755 例全绿）：覆盖率数字以 `facts.md` 为准（本文不重复记具体百分比，避免二次漂移）
  **包口径 15/16**（CI/Ubuntu 口径；Windows 检出为 CRLF 时 v8 行映射会退化，分母虚高，别拿本机数对账）；分母只含参与统计的逻辑行，注释、空行与纯类型文件按设计不计入。
- 产物：`coverage/lcov.info`、`coverage/lcov-report/`（名单口径）；
  `.ci-artifacts/cov-all/coverage-summary.json`（全仓口径）。两者都已进 `.gitignore`。

## 4. 测试面为什么把 `@bah/*` 指到 `src`

各包 `exports` 指向 `dist/`（发布面）。测试若按包名解析就会跑**构建产物**：改了 `src` 忘了
`pnpm build`，用例会静默跑旧代码。所以 `vitest.shared.ts` 把 `@bah/<pkg>` 映射到
`packages/<pkg>/src/index.ts`（子路径 `@bah/llm/mock` → `src/mock/index.ts`），四个配置共用。

边界：**只有测试面**如此；包与包之间的真实运行时依赖仍走包名 + `dist/`（施工单 02 §8 第 1 条）。
类型检查（`tsc -b`）走 project references，与测试面看到的是同一份源码。

## 5. 新写一个用例（三步）

1. 建 `src/<模块>.test.ts`，从被测模块**直接相对导入**（不要绕包名，除非在测跨包接缝）。
2. 需要内核上下文时用 `@bah/test-support`：

```ts
import { withTestContext, captureThrown, fixedClock } from '@bah/test-support'

it('示例：dispose 回滚', async () => {
  await withTestContext(async (test) => {
    const rolled: string[] = []
    await test.use({
      name: 'bank:probe',
      apply: (ctx) => {
        ctx.effect(() => { rolled.push('rollback') })
      },
    })
    await test.start()
    expect(test.ctx.phase).toBe('ready')
  }, '用例结束')          // ← reason 会透传给每个 disposer
  expect(rolled).toEqual(['rollback'])
})
```

3. 只看行为断言，不碰私有结构；错误断言用 `captureThrown` / `captureRejection` 而不是裸 `toThrow()`，
   这样 `code` 与 `bah-<pkg>: ` 前缀都会被验到。

## 6. `@bah/test-support` API 速查

| 导出 | 用途 |
|---|---|
| `createTestContext()` | 建测试上下文：`ctx` / `use` / `start` / `dispose` / `record` |
| `withTestContext(run, reason?)` | 跑完自动 dispose（含抛错路径），**首选** |
| `test.record(name, mode)` | 事件录制器：`values` / `count` / `last()` / `clear()`；waterfall 会交还控制权、bail 不参与裁决 |
| `flush(times?)` | 清空微任务队列（替代 `setTimeout(0)`） |
| `waitFor(predicate, { timeoutMs, label })` | 轮询等待（默认 1s 超时，超时抛 `BahError('wait-timeout')`，**不会无限等**） |
| `fixedClock({ start, step })` | 确定性时钟：`now()` / `tick()` / `advance(ms)` |
| `seededRandom(seed)` | mulberry32 PRNG，同种子逐位一致 |
| `asSessionId(raw)` / `asTicketId(raw)` | 品牌 ID 夹具（**唯一**允许由字面量构造不透明 ID 的地方） |
| `captureThrown(run)` / `captureRejection(run)` | 抓 `BahError` 并校验形状 |
| `parseSnapshotName(file)` / `selectSnapshot(dir, { seq })` | 快照 fixture 解析与代次选择（施工单 12 §3） |
| `recordSnapshot({ dir, run })` | 录制：`session.jsonl` + `llm.jsonl` + `scenario.json`（**只在显式模式下调**） |
| `loadSnapshot(dir)` | 只读加载（缺文件 `snapshot-missing`、坏文件 `snapshot-invalid`、会话 ID 不一致 `snapshot-mismatch`） |
| `compareEvents(a, b)` / `assertSameEvents(a, b)` | 逐条**整行**比对（`seq/at/formatVersion/type/data` 全参与），差异最多列 5 条 |
| `readSessionLog(dir)` / `writeSessionLog(...)` | 会话日志最小 JSONL 实现（与运行时后端同构，由 snapshots 面交叉验证） |
| `createRecordingAdapter(inner, sink)` | 录制 provider 调用（分片原样透传，不改行为） |
| `ReplayAdapter({ exchanges, spec })` | 回放 provider：无网络、无密钥；`remaining()` / `consumed()` 可观察 |

## 7. e2e 面为什么在无密钥时零用例

`vitest.e2e.config.ts` 的语义是「**真实 LLM API**」：没有 `DEEPSEEK_API_KEY` 时不收集任何用例
（整面 skip，`passWithNoTests`），避免缺密钥把 CI 跑红。

**不要**把不需要密钥的用例塞进 e2e 面——那会让「e2e 全绿」在无密钥机器上变成假绿。
不需要密钥的进程级冒烟放 unit 面：`packages/cli/src/main.smoke.test.ts`（真起子进程，验 tsx 运行 +
workspace 解析 + exit code 三条通道）。

### 7.1 端点与模型不锁死厂商

e2e 面现有两条用例（B6，2026-10-27）：

| 用例 | 证明什么 |
|---|---|
| `packages/llm/src/deepseek/adapter.e2e.test.ts` | DeepSeek 适配器流式文本（wire 层） |
| `packages/host/src/boot/plugins/agent.e2e.test.ts` | **主演示链路端到端**：真实模型 → 工具调用 → 审批 → `tool/result` → `turn/end` 事件链完整 |

两条用例都不写死端点与模型，由三个环境变量决定：

| 环境变量 | 缺省 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 无 | 缺失即整面 skip；存在才收集用例 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | 任何 OpenAI 兼容网关 |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 网关上的模型标识 |

例：改打千问平台的兼容端点

```bash
DEEPSEEK_API_KEY=<key> \
DEEPSEEK_BASE_URL=https://maas.qianwenaiapi.com/compatible-mode/v1 \
DEEPSEEK_MODEL=deepseek-v4.1-flash-1017 \
pnpm test:e2e
```

> 密钥只走环境变量 / CI secret，**永不入库**。`--offline` 演示与快照回放都不需要它。

### 7.2 浏览器 smoke（人工留证，未自动化）

**当前状态：未做自动化浏览器测试，也不引入 Playwright**（CI 不加新依赖）。
"真实浏览器打开 Web → 批准/拒绝 → SSE 更新"的证明由**人工执行并留证**（录屏/截图），
与 A2 演示视频一并完成。留证判据（缺一不算过）：

1. `pnpm web`（或 `pnpm demo:web`）启动后，真实浏览器打开 `http://127.0.0.1:7331`；
2. 发一句"查余额"，SSE 实时出现工具卡（待执行 → 完成）——**不刷新页面**；
3. 发一句"给王建国转 800 元"，审批弹窗出现：点**批准**一次（转账完成）；
4. 再发起一笔，点**拒绝**（必填拒绝理由），工具卡呈已拦截态；
5. 截图 / 录屏覆盖 2–4 全程，地址栏与页面内容同框。

网页面 handler/SSE/审批 API 的逻辑面由 `packages/channels` 与 `web.test.ts`（60 例）
在无浏览器环境覆盖；上面 5 条是它们的**人工端到端补证**，不要把单测说成"浏览器已验证"。

移动渠道（施工单 01）新增的测试面，全部在 `pnpm test` 之内（不进 web 面）：

| 面 | 用例 | 钉住什么 |
|---|---|---|
| `packages/channels/src/capabilities.test.ts` | 12 | 六渠道穷尽、10 字段键集一致、mobile↔web 差异面恰五项、能力位单一实现点 |
| `packages/channels/src/http-adapter.test.ts` | 9 | web 与 mobile **同一组夹具**跑两遍结果逐条相同；decide 六码 + verify 四路 + 归属校验 |
| `packages/channels/src/mobile/adapter.test.ts` | 3 | 薄工厂：id、能力位同一引用、sessionId 透传 |
| `packages/channels/src/web/project.test.ts` | 38（+13） | `projectTodo` 确定性/9 态穷尽/openCount；`projectEffects` 双判据与诚实边界 |
| `packages/host/src/boot/plugins/web/config.test.ts` | 14 | `entry`/`entries` fail-loud 6 类 + 未知键仍被拒（admin 无法从配置面开） |
| `packages/host/src/boot/plugins/web/handlers/static.test.ts` | 12 | 白名单命中三件套 / 白名单外不注入 / 绕过变形 / 穿越与畸形编码 |
| `packages/host/src/boot/plugins/web/channel.test.ts` | 6 | **两渠道真装配**：能力位只差五项、入口与白名单不同、闸序与安全头逐条相同 |
| `packages/host/src/boot/plugins/mobile.test.ts` | 6 | `channel:mobile` 真监听 + `/api/session` 10 字段 + admin 默认 404 |

> 双口径提醒（老坑）：`pnpm test:coverage` 只看 `scripts/coverage-allowlist.ts` 的名单（逐文件 100%），
> `pnpm test:coverage:all` 才是全仓行/包口径。**只跑前者会把分母当成全仓**。施工单 01 起
> `packages/channels` 的 `capabilities.ts` / `http-adapter.ts` / `mobile/` 三个窄 scope 进了名单。

## 8. 确定性纪律（上快照回放的前提）

| 禁止 | 改用 |
|---|---|
| `Date.now()` / `new Date()` 造时间 | `fixedClock()`（注入时钟） |
| `Math.random()` | `seededRandom(seed)` |
| 固定 `await sleep(50)` 等副作用 | `flush()` / `waitFor(predicate)` |
| 依赖真实网络 / 真实文件系统路径 | 临时目录（`mkdtempSync(tmpdir())`）+ `afterEach` 清理 |

理由（施工单 12 §7）：回放要求「同快照两次回放全等」；一旦测试里混入真实时间与随机，回放断言必然偶发失败。

## 9. 快照 fixture 命名（施工单 12 §3）

```text
snapshots/
  session.jsonl           # parent（会话主线），缺省代次 v0
  session.v2.jsonl        # parent 的第 2 代
  session.1.jsonl         # child#1（子会话 / 分支）
  session.1.v3.jsonl      # child#1 的第 3 代
```

规则：`session[.序号][.vN].jsonl`；**同组取最高代**；同组最高代重复 → `BahError('snapshot-conflict')`
（fixture 冲突必须人工处理，不许随手挑一个）；该组为空 → `BahError('snapshot-missing')`。

### 9.1 一个快照用例（阶段 7 起）

```text
snapshots/<case>/
  session.jsonl     录制的事件流 = 运行时会话日志格式（能被 JsonlPersistence 原样读回）
  llm.jsonl         每次 provider 调用的请求标识 + 响应分片（llm-mock-server 格式）
  scenario.json     场景输入：prompts / 会话 ID / 时钟 / 种子 / 生效行 / 模型规格
  scenario.ts       场景（录制与回放共用；boot 怎么装由它决定）
  snapshot.test.ts  T-AUD-005 record→replay 全等 + T-AUD-006 两次回放全等
  overlay.yml       （可选）层 4 overlay：在 profile 底座上开一个开关（如 entity-slots 的 slots）
  reverified.json   （可选）回放全等后写入的源码摘要（`pnpm snapshot:reverify`；给 snapshot-fresh 用）
```

现有场景：`headless-basic`（主链路基线）、`web-channel`（渠道不扰动事件流）、
`compaction`（压缩）、`sandbox-compute`（沙箱计算 + 转账）、`plan`（DAG）、
`entity-slots`（实体槽位：每 step 从权威核心读账户/流水，负控见 §9.2）。

- **回放（默认，CI 用）**：`pnpm test:snapshot` —— 只读快照，不联网、不读密钥、不写文件；
  应用由 `scenario.json` 里的**录制行**重建（不读 `profiles/` 与 `bah.yml`），provider 换成 `ReplayAdapter`。
- **录制（人工）**：`pnpm snapshot:record`（脚本注入 `BAH_SNAPSHOT_RECORD=1`，Windows / CI 一致；
  手工等价写法：`BAH_SNAPSHOT_RECORD=1 pnpm test:snapshot`）。
  录完会在同一条用例里立刻回放比对，保证新录的也自洽。
- **纪律**：任何影响**模型可见或用户可见**的改动（提示词段、装配顺序、工具 schema、模型参数、
  事件落账顺序），必须重录快照并在 PR 里说明 `llm.jsonl` / `session.jsonl` 的差异。
  这条已由门禁 `snapshot-fresh` 自动执行：改 `packages/{runtime,llm}/src`（测试文件除外）
  却没改 `snapshots/` 即阻断；纯重构用 `BAH_ALLOW_NO_SNAPSHOT=1` 或提交信息 `[no-snapshot]` 放行。
  门禁默认比对 `HEAD` 与工作树；CI/评审要对比更长区间时设 `BAH_SNAPSHOT_BASE=<ref>`。

### 9.2 实体槽位的快照负控（entity-slots）

`entity-slots` 比其它场景多两条负控，回答同一个问题：**槽位到底在不在比对面内**。

- **入用例**（`snapshots/entity-slots/snapshot.test.ts` 第 4、5 条）：改一条 `assistant/message`
  → 必须红；把 `context/slots` 的 `accounts` 从 3 改 2 → 必须红（差异里点名 `context/slots`）。
- **人工三条**（不入用例，2026-10-28 实测，记录在
  `docs/evidence/2026-10-28-entity-slots/06-s4-adversarial-review.md`）：
  删掉全部 `context/slots`（36 行 → 34 行）→ 比对红；`scenario.json.clock.start` +1 →
  回放 `at` 整体 +1、比对红；把生效行的 `slots.source` 改成 `none` 后回放 →
  `context/slots` 0 条、`request/context` 退回静态画像（只剩 `【当前用户】` + `【补充说明】`）、比对红。

> 第三条只改**生效行**、不动录制件：回放本来就只读 `scenario.json` 的 rows（不读 profile/overlay），
> "层 4 合并后的行"是开关的唯一真相，所以不需要"重录到临时目录"也能证明开关有效。

**证据看哪里**：`session.jsonl` 的 `request/context.texts` 与 `user/message(source=runtime-context)`。
`llm.jsonl` 只有请求标识 + 响应分片，**不含提示词正文**——在那里 grep `【账户概览】` 搜不到，
不代表槽位没进模型。

## 10. 已知边界（不是遗漏，是记账）

| 项 | 现状 | 计划 |
|---|---|---|
| `snapshots/**/*.test.ts` 与 `scenario.ts` 不在 `tsc -b` 覆盖内 | 只经 vitest 转译；`snapshots/` 不是 pnpm 包，没有自己的 tsconfig | 阶段 7 的 harness 与适配器都放在 `@bah/test-support`（**有**类型检查），`snapshots/` 只留薄薄一层装配；不建独立 tsc 项目（避免与 `tsconfig.host.json` 的 solution 结构纠缠） |
| `apps/web/src/*.test.js` 不在 `tsc -b` 覆盖内 | `tsconfig.client.json` 只含 `apps/web/src`（JS 经 `allowJs` 不检查） | 前端行为靠 jsdom 用例兜 |
| `@bah/test-support` 不强制覆盖率 | 00 §11：每文件 100% 只对内核与治理平面强制 | 本阶段为它补了 47 条自测（harness / 录制回放 / 会话日志 / mock-ctx），但**不**纳入 100% 名单：测试脚手架的防御性分支不值得为覆盖率造用例 |
| `fs.cpSync(..., { recursive: true })` 在本机（Node 22.17 / Windows / 非 ASCII 路径）会 abort 进程 | 快照负控用例改为逐个 `readFileSync`/`writeFileSync` 复制三份产物 | 测试代码禁用 `cpSync`；需要复制目录时用显式循环 |
| CI 的 Windows 矩阵（`.github/workflows/ci-matrix.yml` 的 `windows` job）是 `continue-on-error: true` 的**信号位** | **尚未转正**：只观察通过率，不阻断合并；Linux 是唯一阻断面。本仓库从未在真实 Windows CI 上绿过完整矩阵 | Windows 绿了 N 轮之后再讨论转正；转正前不要对外说"Windows CI 已验证" |

## 11. 常见坑

1. **`pnpm.ps1` 被执行策略拦**：在 PowerShell 里用 `cmd /c "pnpm ..."`，或改用 `pnpm.cmd`。
2. **`engines` 告警**：本机 Node v22.17 < `^22.19`，pnpm 只 warn；CI 需统一版本（PROGRESS R1）。
3. **Windows 下 `--filter='./packages/*'`（单引号）匹配不到任何包**：一律双引号（PROGRESS R6）。
4. **jsdom 用例必须 `vi.resetModules()`**：模块级副作用（写 DOM）不可重复触发，否则第二个用例拿到上一次的模块实例。
5. **临时目录用例必须在 `afterEach` 清干净**：Windows 上残留句柄会导致目录删不掉，进而污染后续用例。

## 12. eval 面（W13 + 03/04 单：71 场景 + 四项指标）

```bash
npx tsx scripts/eval.ts                     # 全量（默认 --shard=6；2026-10-26 实测 7.5s，预算 ≤180s）
npx tsx scripts/eval.ts --filter=T          # 按族；也可 --filter=T-03 或 --filter=Q,T
npx tsx scripts/eval.ts --seed=7 --shard=1
npx tsx scripts/eval.ts --json              # 只输确定性报告到 stdout
npx vitest run --config vitest.eval.config.ts   # eval 的用例面（不在主 vitest 里）
```

- 产物：`.ci-artifacts/eval/report.json`（**确定性**：同 seed 两次逐字段全等，`--shard` 只影响调度）
  与 `.ci-artifacts/eval/summary.md`（人读；比率一律带分母，附本次墙钟 p95）。
- 六族与例数：Q 10 / T 12 / P 10 / S 8 / D 10 / K 10 = **60**。ID 规则 `族字母-两位序号`，
  唯一性由 `validateScenarios()` 强制（`packages/eval/src/scenario/validate.ts`）。
- **boot 次数 = 8**，不是 6：W02 冻结的 DSL 增加了 `approval` 维度，复用单位是
  `(family, approval)`；P 族 allow/reject/unavailable 各一次，其余五族各一次。
  `report.bootCount` 是实测计数（不是常量）。
- 四项指标：任务成功率 / 越权拦截率 / 拒答正确率各只统计**声明了对应 metric**的场景；
  平均步数覆盖全部场景；p95 延迟在 summary（墙钟，不参与确定性比对）。
- 隔离：每个 boot 组独立临时 `jsonlDir` + 独立 saga Ed25519 密钥；跑完仓库根 `sessions/` 零新增。
- 失败原因码：`assertion-failed` / `tool-error` / `scenario-timeout`（5s 软超时）/
  `upstream-unavailable`（D 族 incident）。

**评测面的四个已知手法（不是生产行为）**：

1. T/P 等族在同一 app 内串行复用，银行核心状态**跨场景累积**；场景断言按固定顺序写，
   不依赖"每个场景一张干净账本"。
2. S 族按场景替换 `SAGA_BRIDGE_RECIPES.transfer_create`（失败注入），跑完立即复原。
3. D 族把 sentry 的 `guard.maxToolsPerTurn` 抬高到 1000：plan 节点没有 turn（turn=0），
   共享 app 里 10 张计划的工具数会跨场景累计；生产配置不变。
4. K 族用一个本机 HTTP 服务回放已签名语料与篡改样本，专门验证 W06 的本地验签门。

### 12.1 对抗集（W14）

```bash
npx tsx scripts/eval.ts --adversarial      # 45 例（注入 15 / 越权 15 / 幻觉 15）
npx tsx scripts/eval.ts --smoke            # 每族 3 例（9 例，实测 ~4s）
```

- 产物：`.ci-artifacts/eval/adversarial-report.json` + `adversarial-summary.md`；
  报告含逐例 `ID / 输入 / 期望 / 实际 / 归因 / 来源`，族级与总体拦截率带分母。
- `[unverified]` 外部样本单列且**不进分母**；未拦的每一例必须带
  `model-layer / deps-missing / rule-gap` 归因。
- 越权族的"余额未变"是硬断言：拒绝后重新 `account_balance` 并断言 1,234,567 分。

### 12.2 独立重放 / 监管证据包（W15）

```bash
# 只读重放：不启动 Agent / 不调模型 / 不调工具
npx tsx scripts/replay.ts --session <id> --dir <root> --verify
pnpm bah audit replay --session <id> --dir <root> --verify

# 三件套 + manifest，并离线复核
npx tsx scripts/replay.ts --session <id> --dir <root> --pack .ci-artifacts/evidence/<id>
npx tsx scripts/replay.ts --check-pack .ci-artifacts/evidence/<id>

# 快照 Merkle 抽样 10%（.jsonl 每行一个叶子；.json 取数组或 snapshots 字段）
npx tsx scripts/replay.ts --snapshots snapshots/headless-basic/session.jsonl
```

- 硬判据：链连续 + 会话 `seq` 连续 + 原始行与 reader 逐条一致；改/删 `audit.jsonl` 会在
  具体序号处 `chain-broken`。
- 隔离门禁：`scripts/verify-replay-isolation.ts`（gate 名 `replay-isolation`）扫描
  `scripts/replay.ts` 的 **value import 传递闭包**；只允许 `@bah/persistence` / `@bah/util` / `node:*`
  （`@bah/eval` 根入口会拉 host，明确禁止；证据包/Merkle 以相对路径引用）。
  负例：在入口里加一行 `import '@bah/host'` → 门禁红。
- 证据包 manifest 记录每个文件的 sha256 / 字节数 / 条数；`--check-pack` 只读文件即可复核。
- 已知边界：普通 `user/message` 无逐行哈希，改写且保持 seq 合法时单靠重放发现不了；
  会话落盘脱敏使 `tool/call` 的链上摘要只作 warning（不伪装成断链）。

### 12.3 eval 基线（W15）

```bash
pnpm eval:unit          # vitest --config vitest.eval.config.ts（实测 158 例）
pnpm eval:smoke         # 对抗集每族 3 例（9 例，~4s）
pnpm eval:baseline      # 跑全量 71 场景并与 packages/eval/baseline.json 比较
pnpm eval:baseline:record  # 显式重录基线（commit/seed/指标/目标值）
```

- 率下降 >5 个百分点、平均步数超过基线 5%、或分母缩小 → 退出码 1；
- 基线文件入库，含 `commit` / `seed` / 四项指标 / 目标值 / 录制说明；
- **实测 eval 用例数 = 158**（`npx vitest list --config vitest.eval.config.ts | grep -c " > "`）。
  施工文档 v1 的“133 例”是旧数、且当时不在任何 config 的 include 里；不要照抄。
- CI 三步已接进 `scripts/ci.ts`（`eval:unit` / `eval:smoke` / `eval:baseline`），
  `.github/workflows/ci.yml` 通过 `pnpm check:ci` 统一执行。
