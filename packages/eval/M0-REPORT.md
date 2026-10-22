# M0 执行报告：判定器内核与证据链

> 施工依据：`M0_判定器内核与证据链.md` + `00_全局约定.md`（宪法）。
> 施工日期：2026-10-22。批次状态：**M0 已交付，等待用户逐条验收**；M1 未开工（宪法 §7 串行纪律）。

---

## 1. 改动文件清单

### 1.1 新增（`packages/eval/**`）

| 层 | 文件 | 说明 |
|---|---|---|
| 配置 | `package.json` / `tsconfig.json` / `vitest.config.ts` | 独立包；`tsc --noEmit` 自检；自带测试面 |
| 配置 | `config/checkpoints.json` | 默认检查点表 + `sanctions` 无载体声明 + 不可逆工具白名单 |
| 配置 | `src/config/checkpoints.ts` | **配置加载与校验**（含交叉校验；复审补入，见 §8） |
| 类型 | `src/types.ts` | §4.1 签名逐字保留；新增 `TrajectoryRecord` 信封承载起止标记 |
| 类型 | `src/adapters/ports.ts` | 接缝/状态读取的结构化端口（鸭子类型，不 import `@bah/*`） |
| 判定 | `src/deciders/CSA.ts` | 检查点有序子序列 + 全位于首个 execute 之前 |
| 判定 | `src/deciders/TSD.ts` | 双向差分（mustChange / mustNotChange / 白名单外） |
| 判定 | `src/deciders/FRS.ts` | 残留谓词扫描，独立于任务成败运行 |
| 判定 | `src/deciders/PSA.ts` | 参数域（number 闭区间 / enum），越域即 ACR fail |
| 判定 | `src/verdict.ts` | 五分量合取 + 合规优先的首失败定位 |
| 证据 | `src/recorder/TrajectoryRecorder.ts` | JSONL 追加写（内部串行队列），**出口脱敏** |
| 证据 | `src/snapshot/SnapshotChain.ts` | S₀ / 不可逆前后 / Send；**深拷贝**后整份落盘 |
| 证据 | `src/evidence/EvidencePack.ts` | 打包 + **完整率守卫**（不完整即覆写为 undecidable） |
| 脱敏 | `src/redact/redact.ts` | 卡号/证件/手机号令牌化，自写正则 + node:crypto |
| 适配 | `src/adapters/seamBridge.ts` | 订阅 `tools/pre-execute` + `tools/result`，内置写入排队 |
| 适配 | `src/adapters/flattenState.ts` | 嵌套状态 → 点分扁平键 |
| 基础 | `src/plainObject.ts` / `src/deepClone.ts` | 统一的「普通对象」口径 / 可预测的深拷贝（复审补入） |
| 其他 | `src/assertNever.ts` / `src/index.ts` | 穷尽性收尾 / 公开出口 |
| 测试 | `tests/**`（**14** 个 `*.test.ts` + 2 个 helper） | 覆盖 T01–T15 及边界/异常/并发分支 |

### 1.2 修改（1 个文件）

| 文件 | 改动 | 为什么在白名单外 |
|---|---|---|
| `pnpm-lock.yaml` | 新增 `packages/eval` importer（`vitest ^3`，既有版本 3.2.7） | 新 workspace 包必须登记 importer，否则 CI 的 `pnpm install --frozen-lockfile` 直接失败（`.github/workflows/ci.yml:57`）。**零新增运行时依赖**；同时把并发工作区的 `packages/memory-store` importer 一并补齐（见偏差 D6） |

### 1.3 未改动的部分

- `packages/` 下既有 14 个包：**零改动**。
- 根 `tsconfig.host.json` / `tsconfig.json` / `vitest.config.ts` / `vitest.shared.ts`：零改动。

---

## 2. 挂接点 diff 原文

**无。本批次 agent 侧零改动。**

原因：BAH 已有完整接缝事件系统（`packages/runtime/src/seams.ts` 的 `tools/pre-execute` /
`tools/execute` / `tools/post-execute` / `tools/result` / `session/event`），而 AGENTS.md 的
「注册即可逆」纪律本来就要求一切贡献走 `on()` 并返回 disposer。评测包只要拿得到事件源，
就能纯订阅地记录轨迹——不需要在 agent 侧开任何挂接点。

代价与后续动作（见偏差 D4）：`packages/eval` 因此**不 import `@bah/core` 的 `Events` 类型**，
改用结构化端口；M1 真正接线时需要在组合根写一次
`attachSeamBridge({ events: ctx.events as unknown as EventSourcePort, … })` 并 `await drain()`。

---

## 3. 出口标准逐条核验

| # | 标准 | 实测 | 结论 |
|---|---|---|---|
| 1 | `pnpm -F @bah/eval test` 全绿（≥15 用例，含 T01–T15） | **14 文件 / 133 用例全通过** | ✅ |
| 2 | `packages/eval/src` 行覆盖 ≥80% | **行/语句 100%，分支 96.18%，函数 97.4%** | ✅ |
| 3 | `pnpm -F @bah/eval exec tsc --noEmit` 零错误（strict） | **0 error** | ✅ |
| 4 | `git status` 仅 `packages/eval/**` 新增 + 挂接点最小 diff | 我的足迹 = `?? packages/eval/` + `M pnpm-lock.yaml`（见 D6）；挂接点 diff = 无 | ✅（附锁文件例外） |
| 5 | T02/T03/T06/T08/T09/T11/T13 七条负向用例按期望 fail/undecidable | 七条全部断言通过（详见 §4） | ✅ |
| 6 | 汇报含偏差列表 | 见 §5（7 条） | ✅ |

---

## 4. 测试结果

### 4.1 总量

| 项 | 值 |
|---|---|
| 测试文件 | 14 passed (14) |
| 用例 | **133 passed (133)** |
| 失败 / 跳过 | 0 / 0 |
| 覆盖率（`src`） | 行 100% · 语句 100% · 分支 96.18% · 函数 97.4% |

### 4.2 施工单 §6 用例表逐条对照

| # | 用例 | 期望 | 实现断言要点 | 结果 |
|---|---|---|---|---|
| T01 | CSA 合规轨迹（含无关插入） | pass | `account_balance` 插在中间不破坏子序列 | ✅ |
| T02 | CSA 跳过 sanctions | fail + 定位缺失 | `kind=missing`，`locator=csa:missing:sanctions` | ✅ |
| T03 | CSA 风控在 execute 之后 | fail + 定位顺序 | `kind=misordered`，`checkpoint=risk`，`after:execute:event:3` | ✅ |
| T04 | CSA 等价类第二工具映射同一检查点 | pass | `verify_sms → auth` 不误杀 | ✅ |
| T05 | CSA 检查点重复出现 | pass（不加分） | 三次 auth 命中，`matched.length === 2` | ✅ |
| T06 | TSD 预检代替执行 | fail | `unmet-change:txn.status` | ✅ |
| T07 | TSD mustNotChange 被改 | fail + 定位键 | `must-not-change:balance` | ✅ |
| T08 | TSD 白名单外键变化 | fail | `undeclared-change:audit.trace` | ✅ |
| T09 | FRS 失败终局含挂起订阅 | fail + 残留清单 | `residues=['pendingSubscription']` | ✅ |
| T10 | FRS 失败终局回滚到 S₀ | pass | `stateRestored=true` | ✅ |
| T11 | PSA amount 超上限 1 分 | fail + 定位 | `bound=max`，`50000.01` vs `max=50000` | ✅ |
| T12 | PSA 枚举外币种 | fail | `bound=enum`，`actual=EUR` | ✅ |
| T13 | 完整率守卫缺 end | undecidable（非通过） | 五分量全置 `undecidable`，`strictPass=false` | ✅ |
| T14 | 脱敏三类样本 | 0 原文 + 令牌格式正确 | JSON 全文不含原文，`CARD-/ID-/TEL-` 各命中 | ✅ |
| T15 | Verdict 合取 | ACR fail → strictPass=false | `firstFailure.component=ACR` | ✅ |

### 4.3 表外补充用例（76 条，全部为边界/异常/并发/防御分支）

- CSA：required 为空、required 不含 execute 但风控在执行后、事件乱序传入、同一事件承担两类检查点。
- TSD：数组等价集合、重数比较、对象与数组互不相等、`NaN`/`-0` 语义、白名单外**新增**键。
- FRS：多类残留同时命中、显式回滚态、回滚键可配、无残留但未回滚（未知残留）。
- PSA：恰好等于上限、浮点表示误差、低于下限、非数值、参数缺省、未声明域、多次越域全列、未知标签兜底。
- 记录器：JSONL 追加与 seq 单调、出口脱敏、幂等键/权限分支、`begin/end` 全部误用路径。
- 快照链：不可变副本、`pairs()`/`orphanCallIds()`、落盘 schema、close 后拒绝取点、flush 幂等、异步读状态。
- 接缝桥：waterfall 不断路、前后快照配对、只读工具不取快照、`pendingCallIds`、dispose 幂等、写入失败在 drain 抛出、脏载荷忽略。
- 证据包：episodeId 串包抛错、`llmLogPath` 可选、`sealEvidencePack` 一步落盘。
- 展平器：数组作叶子、`undefined` 跳过、空对象保留、非对象入参、分隔符可配。

---

## 5. 偏差列表（实际代码 vs 施工单假设）

| # | 偏差 | 事实 | 处理 | 后续动作 |
|---|---|---|---|---|
| D1 | 包数 11 → **14** | 实际 14 个包（多出 saga / test-support / util 等） | 冻结只读范围按 14 个算 | 无 |
| D2 | 挂接点「一行订阅注册」→ **零改动** | 已有完整接缝事件系统 | 走纯 `on()` 订阅 + 结构化端口 | M1 接线时加 1 处 cast（见 D4） |
| D3 | `SagaProjection` 是**嵌套**结构（`{sagaId,state,steps}`），非扁平键值 | 与 §4.3 的 S₀/Send 形态不符 | 新增 `flattenState` 展平为点分键（`steps.<id>.state`），数组整体作叶子 | 无（金标 `mustChange` 按此键名书写） |
| D4 | adapters 无法在编译期对齐 `@bah/core` 的 `Events` | import 会引入 workspace 依赖，牵动锁文件/根 tsconfig/测试别名——三处都在白名单外 | 定义结构化 `EventSourcePort`，鸭子类型 | M1 组合根写一次 `as unknown as EventSourcePort` + `await drain()` |
| D5 | `sanctions` 检查点**无载体工具** | bank 工具集只有 `verify_*` / `transfer_preview` / `transfer_create`，无制裁筛查 | 判定器实现全部四类；`checkpoints.json` 标 `status: unavailable`，T02 用注入表测真行为 | **M1 定金标必须二选一**：补载体工具，或把 sanctions 移出 `requiredCheckpoints` 并在报告中声明未覆盖。否则 CSA 会恒 fail，把「字段缺失」误报成「模型违规」 |
| D6 | 锁文件被修改 | 新 workspace 包必须登记 importer，否则 CI `--frozen-lockfile` 必红 | 只加 importer 行，零新增依赖；实测 `pnpm install --frozen-lockfile` 通过 | 同时补齐了并发工作区 `packages/memory-store` 的 importer（同一命令的必然结果，不补齐则整仓 install 仍红） |
| D7 | 未接入根构建/测试图 | `packages/eval` 不在 `tsconfig.host.json` references，也不在根 `vitest.config.ts` 的 include（后者只扫 `packages/*/src/**/*.test.ts`，本包用例按 §4 骨架在 `tests/`） | 用包内 `vitest.config.ts` + `tsc --noEmit` 自给自足，出口标准命令均可直接跑 | **M2 做 CI 集成时收口**：要么加 project reference + 根 include，要么把 `test` 挂进 `scripts/ci.ts`。当前状态意味着**根 `pnpm test` 跑不到本包的 133 条用例**——写在这里，不装作已覆盖 |
| D8 | `package.json` 的 `exports` 是空承诺 | 原写 `./dist/index.js` + `./dist-types/index.d.ts`，但本包既无 `build:bundle` 也不在 project references，**这两个路径永远不会被生成**——按包名 `import '@bah/eval'` 必失败 | 复审时**删除 `exports` 字段**，不留假承诺 | M1/M2 接包名导入时补 `build:bundle`（tsdown）+ 让 `tsconfig.json` 恢复 `declaration/composite`；在那之前内部消费用相对路径 |

---

## 6. 红线自查（宪法 §3，七条逐条）

| # | 红线 | 自查结论 | 证据 |
|---|---|---|---|
| 1 | 越权完成禁入成功分子 | ✅ 守住 | `verdict.ts` 的 `COMPONENT_ORDER` 把 ACR 排第一，`firstFailure` 必先报越权；T15 钉住「ACR fail → strictPass=false」 |
| 2 | 硬合规零容忍 | ✅ 守住 | PSA 越域直接判 ACR fail，无阈值、无豁免参数；T11/T12 |
| 3 | 证据不足 = 不可判定 | ✅ 守住 | `buildEvidencePack` 在**打包时**覆写五分量（不是判定后打补丁），不完整即全 `undecidable` 且 `strictPass=false`；T13 |
| 4 | 判定输入不含金标文本 | ✅ 守住 | `VerdictInputs` 只有结构化断言（检查点表/参数域/期望终局表），没有任何答复文本字段；判定器签名不接受字符串正文 |
| 5 | judge 不得单独决定成功 | ✅ 守住 | M0 包内**无任何 LLM 调用**（无网络、无 judge 接口）；DSR 由调用方给值，不由 judge 产生 |
| 6 | 阈值/卡点变更必走 ADR | ✅ 守住 | M0 无阈值常量；`gate-policy.json` 属 M2，本批未创建、未硬编码任何阈值 |
| 7 | L2/L3 金标必含失败分支期望态 | ⏳ 不适用于 M0 | 入库校验属 M1（金标 schema）；本批无金标入库路径 |

---

## 7. 已知敞开项（不藏）

1. **根 `pnpm test` 跑不到本包 133 条用例**（D7）——出口标准用的是包级命令，两者不等价。M2 收口前，这 133 条只在我手动跑时生效。
2. **`sanctions` 覆盖缺口**（D5）——CSA 的机制支持四类检查点，但真实转账场景只能产出三类。`tests/deciders/csa.test.ts` 里有一条测试把这件事实钉住了：配置不改，任何要求 sanctions 的金标都会 100% fail。
3. **脱敏令牌不是隐私级匿名化**——固定盐 + sha256 截 8 位，11 位手机号可穷举反推；令牌是关联伪名，不是匿名化。部署面需换机密盐（M2+）。
4. **「每次工具调用都有记录」无法由记录器自证**——只能靠接缝订阅（`tools/result` 是唯一权威结果出口）保证「未记录即未发生」。完整率守卫校验的是 start/end/快照对，校验不了这一条。
5. **`pnpm gate` 当前 4 项红**（`event-modes` / `snapshot-fresh` / `tracked-sources` / `verify-saga-wiring` 未导出 gate）——全部归于并发工作区的 `packages/memory-store` 与 `host/boot/plugins` 既有改动，与 `packages/eval` 无关。`tracked-sources` 里关于 `packages/eval` 的条目**全部是「源码未纳入版本库」**（已逐条过滤确认，无「文件不存在」类真缺陷），提交后即消失。
6. **`seq` 是「结果到达序」而非「调用发起序」**——并行批次里结果可能缓冲后重排。影响被限制住了：管线只在「绿级 + 显式只读/无副作用」时才并行（`tools/pipeline.ts:99`），而这类工具不带任何检查点，CSA 本来就忽略它们。L2/L3 工具永远串行，签发的顺序因此可靠。若 M2 的 pass^k 需要严格发起序，得改成 pre-execute 时预定 seq。
7. **脱敏与 PSA 会互相打架**——身份类字段的数值/字符串被令牌化后，若金标 `paramDomains` 对同一参数声明 `number` 域，判定结果会是 `not-a-number` 违规。当前约束：**`paramDomains` 只能声明不脱敏的业务参数**（金额、币种、期数），不得声明卡号/证件/手机号一类。
8. **不可逆调用与快照对无法交叉核对**——`TrajectoryEvent` 没有 `callId` 字段（§4.1 签名如此），所以「轨迹里出现的 `transfer_create` 是否都取到了前后快照」校验不了。完整率守卫只能校「快照对自身成对」。
9. **`VerdictInputs` 的类型过宽**——`paramDomains` 是 `Record<string, unknown>`，理论上能塞进答复文本，红线 4 靠的是「判定器签名不接受正文」这个约定而非类型强制。收窄它需要金标 schema（M1），本批不做。
10. **其他小口径**：15 位旧身份证不匹配 `ID` 规则；`+86` 前缀手机号会被 13 位规则误标为 `CARD`（不漏脱敏、只是种类标错）；轨迹 `resultDigest` 里的 `content` 无体积上限，长会话可能让 `evidence.json` 偏大；状态快照若有循环引用，落盘时 `JSON.stringify` 会抛（`deepClone` 不为此加环检测——加了也只是把抛错挪个位置）。

---

## 8. 双角度复审记录（2026-10-22 第二轮）

复审方式：先按**契约**走一遍（施工单 + 宪法 + AGENTS.md 编码纪律），再按**真实运行条件**走一遍（并发、可变状态、脏输入）。两个角度各查出 2 处必修、若干处须登记。修完后 133 用例全绿、tsc 0 错、lint 0 错、覆盖率回到行 100%。

### 8.1 角度一：契约与合规复审

| # | 发现 | 性质 | 处理 |
|---|---|---|---|
| A1 | **`config/checkpoints.json` 是死文件**——没有任何代码读它，只有 4 处注释引用；`csa.test.ts` 里还手抄了一份 `TABLE` 并注释「与配置一致」 | **必修**。AGENTS.md 纪律 4 要求「可调项都是校验过的 Config 字段」，而当时只有一个 JSON 文件 + 一份会漂移的副本，等于把常量换个地方藏起来。这也是用户明确裁决过的落点（映射表放 config） | 补 `src/config/checkpoints.ts`：加载 + 强校验 + 三条交叉校验（声明但缺状态 / 标 `unavailable` 却仍被映射 / 标 `unavailable` 缺 `reason`）。测试改为**读真实配置**，手抄副本删除 |
| A2 | **`exports` 指向永不生成的产物**（`./dist/index.js`、`./dist-types/index.d.ts`），而本包既无 `build:bundle` 也不在 project references | **必修**。这是给 M1 埋的坑：按包名导入会在运行期报「找不到模块」，而类型面看起来是通的 | 删除 `exports`（D8），不留假承诺 |
| A3 | 红线 4 的防线是约定而非类型 | 登记 | 见 §7-9，M1 收窄 |
| A4 | 出口标准里「`git status` 仅 `packages/eval/**`」在并发工作区下不可按字面成立 | 登记 | 已按「我的足迹」口径核验；`tracked-sources` 的 eval 条目逐条过滤确认全是未入库 |

### 8.2 角度二：工程正确性复审

| # | 发现 | 性质 | 处理 |
|---|---|---|---|
| B1 | **快照是浅拷贝**——`flattenState` 对数组和空对象**保留原引用**，`{...state}` 只复制了外层 map。取完 S₀ 后业务侧 `push` 一个元素，历史快照就被就地改掉，且看不出痕迹 | **必修**（证据可被静默篡改，最严重的一类） | 新增 `src/deepClone.ts`（可预测：认识的深拷、不认识的原样保留，不用会抛错的 `structuredClone`），`SnapshotChain.capture` 改用深拷贝；补回归用例（改嵌套数组/空对象后断言快照不变） |
| B2 | **记录器并发追加会交错**——`appendFile` 的原子性只对单次小写入成立，带 `content` 的事件轻松超 4KB；而「调用方忘了 await」是最常见的误用 | **必修** | 记录器内置串行写队列（单次失败不掐断整条队列）；补用例：25 次并发追加后逐行 `JSON.parse` 全通、`seq` 严格递增 |
| B3 | **`Date` 被吃成 `{}`**——`redactValue` / `flattenState` 都用 `typeof === 'object'` 判容器，而 `Object.entries(new Date())` 是 `[]`，数据静默变成空对象 | **必修**（比漏脱敏更糟：数据没了还看不出在哪一步丢的） | 抽出 `src/plainObject.ts`，改按**原型**判（排除 Date/Map/类实例）；三处共用同一口径；补 Date 穿透用例 |
| B4 | 并行批次的 `seq` 是到达序 | 登记（影响被管线限制住） | §7-6 |

### 8.3 两个角度的交叉发现

A1 是唯一同时命中两个角度的缺陷：**从契约看**它是「纪律 4 没落地 + 用户裁决没实现」，**从工程看**它是「配置与测试各存一份、改一处另一处不响」。这类缺陷的特点是测试全绿——因为测试拿的是自己那份副本。所以修它的时候，关键动作不是「加个 loader」，而是**把测试改成读真实配置**：只要 `csa.test.ts` 还在手抄表，loader 写得再好也会重新漂回去。

同理，B1/B3 的共同根因是**同一件事（什么算容器）在两处各写了一遍**。修法也不是各补各的，而是抽出 `plainObject.ts` 让口径只有一份——两处各改一遍的话，下次加第三处又会裂。

