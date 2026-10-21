# 测试地基（Testing）

> 适用：底座阶段 2 起。规格依据：施工单 00 §9（纪律）、01 §5–§7（测试面 / 门禁 / 覆盖率）、
> 12 §3（快照回放）。本文件是**操作手册**：改一行代码该跑哪条命令、新用例该怎么写。

## 1. 四个测试面（一个都不能省）

| 面 | 命令 | 配置 | 装什么 | 现状（2026-10-22 实测） |
|---|---|---|---|---|
| unit / 集成 | `pnpm test` | `vitest.config.ts` | 纯函数内核 + 接缝集成（真 Context，不 mock 内核） | 149 文件 / 1335 用例 |
| e2e | `pnpm test:e2e` | `vitest.e2e.config.ts` | **真实 DeepSeek API**（`*.e2e.test.ts`） | 无 `DEEPSEEK_API_KEY` 时零收集（**设计如此**，见 §7） |
| snapshot | `pnpm test:snapshot` | `vitest.snapshot.config.ts` | `snapshots/**/*.test.ts`，**无密钥回放**（录制需显式开关） | 4 文件 / 14 用例 |
| web | `pnpm test:web` | `vitest.web.config.ts` | `apps/web/src/**/*.test.js`，jsdom | 5 文件 / 46 用例 |

一条命令跑全链（本地等价 CI，fail-fast）：

```powershell
cd D:\项目集\微众杯银行ai智能体\BAH\MonoRepo
pnpm check
```

`pnpm check` 共 **10 步**，任一步红即停并给出耗时汇总：

```
typecheck → lint → build → test → test:coverage → gate → e2e → snapshot → web → rag:check
```

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

## 2. 用例命名纪律（硬性）

1. 施工单 §10 给了用例 ID 的，**ID 必须与该表逐字一致**，编号不得增删改，期望值逐条对应。
   例：`it('T-CORE-007 handler 不调 next() → 拥有判决，后续 handler 不执行', …)`。
2. 规格没有 ID 的补充用例，**不带 ID**，名字直接描述行为（覆盖率补丁用例就是这一类）。
3. 测试文件与被测文件同目录（`src/foo.ts` ↔ `src/foo.test.ts`），不分 `test/` 目录。
4. 用例只通过**公开 API** 验证行为；不测私有字段（否则 100% 覆盖率会逼出无意义测试，施工单 02 §12）。

## 3. 覆盖率政策

- **按文件强制 100%**，名单在 `scripts/coverage-allowlist.ts`；`vitest.config.ts` 把名单**翻译成
  coverage include 模式**（不把包名写死），因此名单扩容时门禁自动扩容。
- 阈值 `lines: 100` 是名单内文件的**汇总兜底**；名单外的包不参与统计。
- 排除项：`*.test.ts`（测试自己）、`**/index.ts`（re-export 无逻辑）、`packages/core/src/api.ts`
  与另外三个**纯类型模块**（`runtime/src/tools/types.ts`、`llm/src/llm/types.ts`、
  `runtime/src/compaction/types.ts`）——零可执行行，统计它们只会得到假的 0%。
- 产物：`coverage/lcov.info`、`coverage/lcov-report/`、`coverage/coverage-summary.json`
  （后者给脚本/答辩材料读数字）。`coverage/` 已进 `.gitignore`。
- 强制名单外的代码（如 `@bah/test-support` 自身）**不要求** 100%——但它的核心逻辑仍有自测。

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

## 7. e2e 面为什么是零用例

`vitest.e2e.config.ts` 的语义是「**真实 DeepSeek API**」：没有 `DEEPSEEK_API_KEY` 时不收集任何用例
（整面 skip，`passWithNoTests`），避免缺密钥把 CI 跑红。第一个真实用例要等阶段 4（模型层）+ 阶段 5（主循环）。

**不要**把不需要密钥的用例塞进 e2e 面——那会让「e2e 全绿」在无密钥机器上变成假绿。
不需要密钥的进程级冒烟放 unit 面：`packages/cli/src/main.smoke.test.ts`（真起子进程，验 tsx 运行 +
workspace 解析 + exit code 三条通道）。

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
```

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

## 10. 已知边界（不是遗漏，是记账）

| 项 | 现状 | 计划 |
|---|---|---|
| `snapshots/**/*.test.ts` 与 `scenario.ts` 不在 `tsc -b` 覆盖内 | 只经 vitest 转译；`snapshots/` 不是 pnpm 包，没有自己的 tsconfig | 阶段 7 的 harness 与适配器都放在 `@bah/test-support`（**有**类型检查），`snapshots/` 只留薄薄一层装配；不建独立 tsc 项目（避免与 `tsconfig.host.json` 的 solution 结构纠缠） |
| `apps/web/src/*.test.js` 不在 `tsc -b` 覆盖内 | `tsconfig.client.json` 只含 `apps/web/src`（JS 经 `allowJs` 不检查） | 前端行为靠 jsdom 用例兜 |
| `@bah/test-support` 不强制覆盖率 | 00 §11：每文件 100% 只对内核与治理平面强制 | 本阶段为它补了 47 条自测（harness / 录制回放 / 会话日志 / mock-ctx），但**不**纳入 100% 名单：测试脚手架的防御性分支不值得为覆盖率造用例 |
| `fs.cpSync(..., { recursive: true })` 在本机（Node 22.17 / Windows / 非 ASCII 路径）会 abort 进程 | 快照负控用例改为逐个 `readFileSync`/`writeFileSync` 复制三份产物 | 测试代码禁用 `cpSync`；需要复制目录时用显式循环 |

## 11. 常见坑

1. **`pnpm.ps1` 被执行策略拦**：在 PowerShell 里用 `cmd /c "pnpm ..."`，或改用 `pnpm.cmd`。
2. **`engines` 告警**：本机 Node v22.17 < `^22.19`，pnpm 只 warn；CI 需统一版本（PROGRESS R1）。
3. **Windows 下 `--filter='./packages/*'`（单引号）匹配不到任何包**：一律双引号（PROGRESS R6）。
4. **jsdom 用例必须 `vi.resetModules()`**：模块级副作用（写 DOM）不可重复触发，否则第二个用例拿到上一次的模块实例。
5. **临时目录用例必须在 `afterEach` 清干净**：Windows 上残留句柄会导致目录删不掉，进而污染后续用例。
