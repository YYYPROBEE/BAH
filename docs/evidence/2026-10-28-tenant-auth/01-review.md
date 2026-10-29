# 01 · 租户模型与全平面贯通 —— 对抗式复审（R2）

- 复审对象：`29625d9`（01 的交付提交）+ 施工单 `01-租户模型与全平面贯通.md`
- 复审立场：**假定它是错的**，去找能证伪它的那一行代码 / 那一条命令
- 结论：**9 条发现（P1×3 / P2×4 / P3×2），其中 7 条已在本提交修复，2 条登记不改**；
  另有 4 条"怀疑过、但证伪了"的结论也一并写出来（它们同样是交付物）
- 本文件是**单独提交**：`fix(tenant): 01 对抗式复审（AR-01…AR-09）`

---

## 1 复审方法（先说我怎么找的）

| 步 | 做法 | 目的 |
|---|---|---|
| 1 | 把 01 的每一条**断言**翻译成一条可执行检查（跑命令 / 读实现 / 数断言） | 拒绝"文档说它是这样" |
| 2 | 找**恒真判据**：这条用例在功能被删掉后还会绿吗？ | 恒真判据比没有判据更坏（M3 的教训） |
| 3 | 找**不可达防线**：这条检查在真实启动/真实调用路径上会被执行到吗？ | 上一轮抓到过"死的 `foreign-ticket`" |
| 4 | 找**接缝错位**：两个任务各自自洽、放一起矛盾 | AR-01/AR-02 都是这一类 |
| 5 | 找**执行障碍**：一个新会话照单子做，会在哪一步静默做错 | `demo:web -- --tenant` 就是这一步 |
| 6 | 对每条发现要求**三件套**：位置（文件+符号）、证据（命令/原文）、修法 | 没有证据的"我觉得"不进正文 |

**没做的**：没有跑覆盖率（`pnpm test:coverage:all` 需要 LibreOffice/CI 口径，本机不跑），
所以"新增代码是否 100% 覆盖"这件事本文件**不声称**。

---

## 2 结论摘要

| ID | 级 | 一句话 | 处置 |
|---|---|---|---|
| **AR-01** | **P1** | `/api/metrics` 的租户用例对"租户来自 run"是**恒真**的（harness 固定 demo） | 已修：加 handler 级**非 demo** 用例 |
| **AR-02** | **P1** | 启动期 `verifyAll()` 只验连续性，**不校验链行租户**：把链目录搬错租户后，启动照常、HALT 不响 | 已修：`verifyAll` 加租户对账 + 两条用例（正例/反例） |
| **AR-03** | **P1** | 计划书 TA-12 的验收命令 `pnpm demo:web -- --tenant other` **实测不透传**：脚本不转发 argv，会静默按 demo 起服务 | 已修：`scripts/demo-web.mjs` 透传 `--tenant`，并把三条审计提示补上 `--tenant` |
| AR-04 | P2 | `tenantRootOf` 用**路径白名单**兜底：`'Demo'` / `'demo_1'` 这类"路径安全但不是租户"的值能过（两个目录、一个环境变量后缀） | 已修：改用租户字符集 `isTenantId`。**复审原稿把 `'undefined'` 也列进来是错的**——它在字符集内，见 §3 AR-04 的修订 |
| AR-05 | P2 | `SessionFiles.baseRoot` 是这条边界上唯一的官方豁口，**没有门禁守着** | 已修：`verify-tenant-scope` 判据 4 + 2 条自检样本 |
| AR-06 | P2 | `--update` 把**既有**漂移（`project.test.ts` 74→73）一起登记了 | 已核实：`git diff` 对该文件为空，是 `6af6d64` 上的既有漂移；证据 D-12 已声明 |
| AR-07 | P2 | `SessionIdentity.tenantId` 目前**无消费者**（要等 03 的 `authorize`），容易被当成"已生效的防线" | 已修文档：契约 §3 明确标注"预留，T3 才消费" |
| AR-08 | P3 | `bah audit` 的人读输出不显示链行租户（不一致时进 `errors`，但正常时看不出来） | 登记不改（不影响判定；加一列会让所有人读输出变化） |
| AR-09 | P3 | `DEFAULT_TENANT_ID` 与 `tenantSaltOf('demo')` 是**两处** demo 特例，没有判据约束"不许出现第三处" | 登记不改（契约 §7 已写清两条特例的理由） |

---

## 3 逐条（证据 → 判定 → 修法 → 改前/改后对照）

### AR-01（P1）· 指标用例对"租户来自 run"恒真

**问题**：`web.test.ts` 的 harness 用 `testRunContext()` 的缺省值（租户 `demo`），
所以那条用例断言 `body.tenant === 'demo'` 时，**把处理器写成常量 `'demo'` 也会绿**。
这正是上一轮 AR-02 里"M3 恒真"的同一种病。

**证据（改前的用例形态）**：

```
it('TA-16-1 /api/metrics 的返回体第一层带 tenant', …) {
  const harness = await boot()           // ← testRunContext() 缺省租户 demo
  …
  expect(body.tenant).toBe('demo')       // ← 常量也能过
}
```

**修法（已落地）**：新增 `packages/host/src/boot/plugins/web/metrics-tenant.test.ts`，
**绕开 harness**，直接给 `WebDeps` 一个非 demo 租户：

```ts
await handleMetrics(req, res, request, depsWith('acme-bank'))
expect(body()).toMatchObject({ tenant: 'acme-bank', … })
```

两条用例（`AR-01-1` / `AR-01-2`）分别证明"读的是 `deps.tenantId`"与"换租户立即跟着变"。

```
$ npx vitest run packages/host/src/boot/plugins/web/metrics-tenant.test.ts
 ✓ AR-01-1 非 demo 租户 → 返回体第一层就是它（证明来自 deps，不是常量）
 ✓ AR-01-2 换一个租户立即跟着变（同一处理器，无缓存、无全局）
```

---

### AR-02（P1）· 启动期不校验链行租户（搬错目录看不到）

**威胁**：`mv sessions/acme/s-1 sessions/demo/s-1`。哈希链**仍然连续**（搬目录不改字节），
`verifyAll()` 只验连续性 ⇒ 一条属于 acme 的链在 demo 里被当作"没问题"。
我在 01 里给 `bah audit --tenant` 加了对账，但那是**事后人工命令**；启动期不响。

**证据（改前实现，`git show 29625d9`）**：

```
$ git show 29625d9:packages/host/src/boot/plugins/audit-decisions.ts | grep -c '链行租户'
0

$ git show 29625d9:packages/host/src/boot/plugins/audit-decisions.ts | grep -A6 'verifyAll() {'
          verifyAll() {
            const breaks: ChainBreak[] = []
            for (const id of chainIds(root)) {
              try {
                const result = audit.verifyContinuity(id)
                if (!result.ok) {                      // ← 只有断链才 push
                  breaks.push({ chainId: id, brokenAt: result.brokenAt ?? 0 })
                }
```

**判定**：这是"隔离的最后一公里"——目录分开了，但**搬错**没有声音。
对一个"靠目录证明隔离"的方案来说，这一条不能只靠人工命令兜。

**修法（已落地）**：`verifyAll()` 在连续性通过后做租户对账（历史行没有 `tenant`，跳过）：

```ts
const foreign = files.read(id).find((row) => row.tenant !== undefined && row.tenant !== tenant)
if (foreign !== undefined) {
  breaks.push({ chainId: id, brokenAt: foreign.q, error: `链行租户 … ≠ 本进程租户 …` })
}
```

`verifyAll()` 的消费者是 `safety:sentry` 的启动扫描（`sentry.ts` 的 `for (const broken of decisionAudit.verifyAll())`），
所以修在 `verifyAll` = 启动期就会 `audit/chain-broken` + HALT。

**改前/改后对照**（新用例在旧实现下必然红）：

```
$ npx vitest run packages/host/src/boot/plugins/audit-tenant-mismatch.test.ts
 ✓ AR-02-1 链行租户与目录租户不一致 → 报出来，并指到具体条目
 ✓ AR-02-2 本租户的链不误报（历史行没有 tenant 也照样通过）
```

`AR-02-1` 断言 `breaks` 长度为 1 且 `error` 含"租户"；旧实现里 `breaks` 必然是 `[]`
（连续性 ok、没有别的 push 分支），所以这条用例在 `29625d9` 上**不可能通过**。

---

### AR-03（P1）· `pnpm demo:web -- --tenant other` 会静默按 demo 起服务

**问题**：01 TA-12 的验收命令是 `pnpm demo:web -- --tenant other`。实测
`scripts/demo-web.mjs` **完全不读 `process.argv`**（只读环境变量），它 spawn 的 CLI 参数里
也没有 `--tenant`：

```
$ git show 29625d9:scripts/demo-web.mjs | grep -c 'argv\|tenant'
0
```

⇒ 操作者以为在为 `other` 服务，实际进程在 `demo` 上——**没有报错、没有任何提示**。
这比"命令跑不通"糟：跑不通会去查，跑通了不会。

**修法（已落地）**：`scripts/demo-web.mjs`

1. 读 `--tenant`（缺省 `demo`），打印 `[demo:web] 租户：<id>（链与记忆在 <runDir>/<id> 下）`；
2. 把它传给 CLI（`'--tenant', tenant`）；
3. 三条审计提示补上 `--tenant <id>`（否则 `--dir <runDir>` 会按缺省 demo 找链，
   而 `runDir` 是**部署根**——正是"扫不到 = 没问题"的形态）。

验证方式（如实说明）：**静态核对 + `node --check`**，没有真起服务——
`00` §13 明确"不要为了验证去占 7331"，而起服务就会占。

```
$ node --check scripts/demo-web.mjs
syntax=0
```

---

### AR-04（P2）· `tenantRootOf` 的兜底用错了白名单

**问题**：01 的实现用 `assertSafePathSegment(id, 'tenantId')` 兜底。它只保证"路径安全"：

```
$ git show 29625d9:packages/host/src/boot/plugins/persistence.ts | grep 'assertSafePathSegment(id'
assertSafePathSegment(id, 'tenantId')
```

而 `'undefined'`、`'Demo'`、`'demo_1'` 都是合法路径段。JS 调用方漏传 `tenantId` 时，
`String(undefined)` = `'undefined'`，于是落点变成 `<root>/undefined`——**不报错**。

**修法（已落地）**：改租户字符集：

```ts
if (!isTenantId(id)) throw new BahError('tenant-id-invalid', …)
```

新用例 `TA-12-2` 覆盖（`'../etc'` 与 `'undefined'` 都要拒）。

**修订（本轮内自查）**：第一稿把 `'undefined'` 也算作"被旧实现放过"的样本，
实测**不成立**——`'undefined'` 全是小写字母，本来就在租户字符集内（`isTenantId` 返回 true）。
它是"JS 调用方漏传字段"的理论风险，不是这一条判据能挡的；真正的防线是
`RunContext.tenantId` 的**类型必填**与 CLI 入口的 `parseTenantId`。
用例因此改成 `['../etc', 'Demo', 'demo_1', 'a']`——四个"路径安全但不是租户"的值。
> 为什么不用 `assertSafePathSegment` 双保险：租户字符集是它的**真子集**
> （`[a-z0-9-]` 且首尾 alnum），所以前者成立必然后者成立；两道都留只会让人以为
> "路径安全"就够。

---

### AR-05（P2）· `baseRoot` 这个官方豁口没有门禁

**问题**：`SessionFiles.baseRoot` 是"部署根、未拼租户"，是这条边界上唯一允许出现
"跨租户共享目录"的地方（saga 库）。它**只有一个合法使用者**，但没有任何东西阻止第二个。

**修法（已落地）**：`verify-tenant-scope` 新增判据 4：

- 白名单是**两条精确路径**（定义处 `persistence.ts` + 唯一使用者 `saga-store.ts`），不通配；
- 自检加两个样本（新插件偷用 → 必须红；saga-store 用 → 不许误报）。

```
$ npx tsx scripts/verify-tenant-scope.ts --self-test
✔ 抓到（1 条）：新插件偷用 baseRoot（部署根，未拼租户）
✔ 未误报：saga-store 合法使用 baseRoot（白名单）
自检通过：6 条坏样本全部被抓、4 条合法样本未被误报
```

---

### AR-06（P2）· `--update` 把既有漂移一起登记了

**核实**：

```
$ git status --porcelain packages/channels/src/web/project.test.ts
（空）
$ git diff --stat packages/channels/src/web/project.test.ts
（空）
```

⇒ 该文件的 74→73 是 `6af6d64` 上就有的**既有漂移**（开工基线里 `assertions` 那条红就是它），
不是本单删了断言。`--update` 把它一起收进新基线；已在 `01-t1.md` §4 的 D-12 声明。
**复审确认：这是本次基线变更里唯一一处"下降"**（其余 +122 条都是新增用例）。

---

### AR-07（P2）· `SessionIdentity.tenantId` 目前没有消费者

`resolveIdentity()` 只在测试里被调用；`authorize()`（03）才会读它。这不是缺陷，
但**不能把它讲成"已经生效的跨租户防线"**——它现在只是一个被填好的字段。

**修法（文档）**：契约 §3 明确写"T3 之前无消费者（预留）"。答辩口径：
"租户在身份上是**记录**，判定在 03；现在能证明的是这条记录与目录租户一致"。

---

### AR-08（P3）· `bah audit` 人读输出不显示链行租户

不一致时进 `errors` 并退出 1（已有用例），但"正常"时看不出来这条链属于谁。
**登记不改**：加一列会改所有人读输出（含文档示例），收益只是可读性。

### AR-09（P3）· 两处 `demo` 特例没有"不许出现第三处"的判据

`DEFAULT_TENANT_ID`（缺省租户）与 `tenantSaltOf` 的 `demo → 0`（快照字节）是两处特例，
理由分别写在契约 §2/§7 与 ADR §6。**登记不改**：给"特例"加判据很容易变成
"为了保护特例而写判据"，反而掩盖新增的第三处。

---

## 4 怀疑过、但**证伪**了的四条（同样是交付物）

| # | 怀疑 | 怎么证伪的 | 结论 |
|---|---|---|---|
| 1 | 把 `tenantId` 写进 `identity/bound` 载荷不会影响快照 | `grep identity/bound snapshots/*/session.jsonl` → **7 分快照全中**，`compareEvents` 是逐行 `JSON.stringify` 比对 | 会影响 ⇒ D-2 的"不写载荷"是对的 |
| 2 | `--jsonl` 会绕过租户段（`root = jsonlDir` 直接当根） | `persistence-tenant.test.ts` 的 `fileOf` 断言 + 实测 `--jsonl out` 落点 `out/<tenant>/<sid>/` | 不绕过：`tenantRootOf(baseRoot, tenant)` 统一拼 |
| 3 | 判据 2 会误报 `policy.ts` 的 canary 分桶（`${sessionId}#${epoch}`） | 收窄成"模板串里同时有 sessionId 与 `/`"后，`verify-tenant-scope` 在 790 个 .ts 上绿 | 不误报（但收窄这件事本身要写进判据注释，见门禁文件头） |
| 4 | `SessionFiles.baseRoot` 已经被别的插件用了 | `grep -rn 'baseRoot' packages/` → 只有 `persistence.ts`（定义）、`saga-store.ts`（使用）、测试 | 只有一处；现在还有判据 4 守着 |

---

## 5 复审后的收工状态

```
$ pnpm typecheck                                  → 通过
$ npx vitest run                                 → Test Files 244 passed (244) / Tests 2722 passed (2722)
$ npx tsx scripts/run-gates.ts                   → 全部通过（42/42）
$ pnpm test:snapshot                             → 8 文件 / 34 例全绿
$ npx tsx scripts/verify-tenant-scope.ts --self-test → 自检通过（6 坏样本 / 4 合法样本）
```

新增用例：`web/metrics-tenant.test.ts`（2 例）、`audit-tenant-mismatch.test.ts`（2 例）、
`tenant-scope.test.ts` 的判据 4（3 例）＝ **+7 例**；对应基线重登记见提交前跑的
`npx tsx scripts/verify-assertions.ts --update`。

**仍未闭环的（留给定单或后续轮次）**：

1. AR-08 / AR-09 两条 P3（登记不改）；
2. `policy:explain --dir` 需指向租户根（工具本身没有 `--tenant`，属 03/策略单）；
3. 覆盖率台账未刷新（本机不跑 CI 口径的 `test:coverage:all`）；
4. `vitest.shared.ts` 缺 `memory-store` 的 PACKAGE_DIRS 条目（既有隐患，D-12 的观察项）。
