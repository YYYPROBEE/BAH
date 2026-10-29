# 04 · 隔离验证与交付 —— 对抗式复审（R3）

- 复审对象：`tenant-04-delivery` 工作树（基线 `be9426b` = 03 的收工提交），对照
  `04-隔离验证与交付.md` 与 `05-对抗式复审.md`
- 复审立场：**假定"隔离"只是文档声明**——去找那条能证明它不成立的路径拼接、那条能绕过协议的 Origin
- 结论：**14 条发现（P1×3 / P2×7 / P3×4），7 条在本提交修复，7 条登记不改**；
  另有 4 条"怀疑过、但证伪了"的结论
- 关键事实：本单的 P1 全部来自**"门禁之外的真实调用方"**——布局门禁绿了，但 `bah audit replay`
  与 `scripts/replay.ts` 仍在按平铺路径找会话（AR-45/46）

> 编号接 03 的 AR-44，从 **AR-45** 起。

---

## 1 复审方法

| 步 | 做法 | 目的 |
|---|---|---|
| 1 | 把 04 的判据逐条翻译成"反例长什么样" | 门禁只会查它认识的形态；先写反例再写实现 |
| 2 | 两次真实进程（`tenant-matrix`） | 隔离必须由**进程外**观察者证明（I1） |
| 3 | 覆盖率按文件看，不看总数 | 总数 88% 会掩盖一个 77% 的鉴权文件 |
| 4 | 把"门禁豁免"逐条问："这个文件真的已经拼了租户吗？" | 找到 replay / policy 两个"调用方负责"的接缝 |
| 5 | 每条发现三件套：位置 / 证据 / 修法 | 没有证据的发现不进正文 |

**没做**：CI 口径的全仓覆盖率（本机 v8 的分母口径与 CI 不同，台账不认本机数）。

---

## 2 结论摘要

| ID | 级 | 一句话 | 处置 |
|---|---|---|---|
| **AR-45** | **P1** | `bah audit replay` 不拼租户段：`--dir sessions` 实际找 `sessions/<sid>`，多租户时可能读错租户 | 已修：加 `--tenant`（缺省 demo，校验 `isTenantId`），测试覆盖"acme 会话在 demo 下读不到" |
| **AR-46** | **P1** | `scripts/replay.ts` 同样平铺；`--pack` 路径也跟着错 | 已修：加 `--tenant`，用法/文档同步 |
| **AR-47** | **P1** | `web/auth/throttle.ts` 行覆盖 **77.14%**，低于 TA-54 的 90% 门槛 | 已修：补 4 条用例（locked / 退避上限 / 表满 / prune+reset），升到 100% |
| AR-48 | P2 | 布局门禁第一版的 `join(...)` 解析用 `[^()]*`，漏掉 `join(root, String(sessionId))` ⇒ **自检红** | 已修：括号配对解析；自检从"1 项不符"变全绿 |
| AR-49 | P2 | 布局门禁对"root 已是租户根"的 API 误报（replay / policy-admin） | 已修：精确豁免（逐条理由）+ 用法改成 `<tenant-sessions>` |
| AR-50 | P2 | CSRF 协议开关初版是单向（https 受控、http 恒放）：与"secure=true ⇔ 整站 HTTPS"不一致 | 已修：二选一（secure=true 拒绝 http），CSRF 用例覆盖三向 |
| AR-51 | P2 | 04 §TA-53 要求把 §3 行 3 改成"跨会话/跨租户一律 404"，与 03 AR-02、实际 `foreign-ticket=403` 冲突 | **登记**：保留 403 + 跨租户 401 的诚实口径（D-5） |
| AR-52 | P2 | TA-54 要求更新 `docs/coverage-baseline.json`，但台账明确"只认 CI 口径" | **登记**：台账不动；新增 `coverage-auth.txt` 记录本机 auth/authz 读数（D-6） |
| AR-53 | P2 | `saga.tenant` 标记只是**告警**：忽略告警仍会共库 | **登记**：计划就要求 warn；写入 `docs/tenant.md` |
| AR-54 | P2 | `tenant-matrix --keep` 仍会关进程，只保留目录 | **登记**：与计划"保留路径"一致；文件内已注明 |
| AR-55 | P2 | 布局门禁判据 1 对任何含 `tenant` 字样的文件跳过（粗粒度） | **登记**：与 01 判据 2 同口径；精确豁免只给两个"会话根 API" |
| AR-56 | P2 | 反代告警只查"配了管理凭据 + host≠回环"，不检测反代本身 | **登记**：部署约束；不实现 XFF（计划明确） |
| AR-57 | P3 | `tenant-matrix` 用 stress 数据集（才有 u-1/u-2 两个用户），不是 demo 档 | **登记**：证明机制不证明某档数据；脚本注释写明 |
| AR-58 | P3 | `audit replay` 缺省 `--tenant demo` 对"平铺旧目录"是破坏性变化 | **登记**：01 已迁移布局；用法/测试同步 |

---

## 3 逐条（证据 → 判定 → 修法）

### AR-45 / AR-46（P1）· 门禁绿了，调用方还在按平铺路径找会话

布局门禁 `verify-tenant-isolation` 的判据 2/3 都绿（`fileOf` 正确拼了租户），
但 `bah audit replay` 的实现是：

```ts
// 修复前
replaySession({ root: resolve(cwd, parsed.args.dir), sessionId })
```

`--dir sessions` 会去找 `sessions/<sid>/session.jsonl`——真实布局是 `sessions/<tenant>/<sid>/`。
单租户时表现为 `session-missing`（看起来像"会话不存在"）；多租户时若恰好有同名会话，
**会读到另一个租户的日志**。`scripts/replay.ts` 同样。

**修法**：两处都加 `--tenant`（缺省 demo，CLI 层 `isTenantId` 校验），root 改成
`<dir>/<tenant>`。新增用例：

```text
✓ 租户隔离：acme 的会话在默认 demo 下读不到，切 --tenant 才可见
```

**为什么门禁没抓到**：门禁查的是 `fileOf` 与"缺租户的 join"，`replaySession` 的 root 参数
是**字符串透传**，不是 `join(...sessionId)` 形态。这是"判据只看自己认识的形态"的典型。

---

### AR-47（P1）· 覆盖率门槛抓到 77% 的鉴权文件

TA-54 要求 `web/auth/*`、`web/authz/*` 行覆盖 ≥90%。补测前：

```text
77.14% lines 54/70  plugins/web/auth/throttle.ts
```

未覆盖的是容量分支（1024 桶满）、`locked()`、退避上限、prune 过期清理。
这些正是"攻击者用随机 userId 洪水把真实用户桶挤掉"的防线。
**修法**：补 4 条用例后 `100.00% lines 70/70`；auth/authz 最低为 `session-store 92.72%`。

---

### AR-48（P2）· 门禁自己的解析器漏了嵌套调用

第一版判据 1 用 `join\(([^()]*)\)` 抓参数；`join(root, String(sessionId), 'session.jsonl')`
因为 `String(...)` 的括号导致整条不匹配。**自检第一轮就红**（"join 缺租户段"未被抓到），
这正是 00 R12 要求 `--self-test` 的原因。

**修法**：括号配对 + 跳过字符串字面量的扫描器（`joinCalls`）。

---

### AR-49（P2）· "全仓"与"调用方负责"的接缝

判据 1 首轮命中两个文件：

- `packages/persistence/src/replay/index.ts:78`：`ReplayOptions.root` **按契约就是会话根**；
- `scripts/policy-admin-lib.ts:499`：`sessionsDir` 按契约是租户目录（`policy:explain --dir`）。

给它们强加 tenant 实参只会制造第二份拼接。**修法**：`JOIN_EXEMPT` 精确路径 + 逐条理由；
同时把 `policy:explain` 的用法改成 `<tenant-sessions>`、`scripts/replay.ts` 加 `--tenant`。
**登记**：判据 1 对"含 tenant 字样就跳过"仍是粗粒度（AR-55）。

---

### AR-50（P2）· CSRF 协议开关必须二选一

初版实现只拦"https 且 secure=false"，http 在 secure=true 下仍放行。测试期望
"secure=true 时 http 不通过"（避免 HTTPS 站点在 http 入口上被 CSRF），实现与测试不一致。

**修法**：`sameOriginHost` 的协议判定改成二选一；三条用例覆盖 http/https/端口。

---

### AR-51（P2，登记）· 04 要的 404 与 03 的 403 冲突

04 §TA-53 写"§3 第 3 行'跨会话 403'改成'跨会话/跨租户一律 404'"。但：

- 03 AR-02 已论证 `foreign-ticket` 必须保持 **403**（`web.test.ts` 的 W16 基线）；
- 跨租户根本走不到资源层（认证层 401）。

写成 404 会让文档与代码/证据互相打脸。**处置**：保留诚实口径
"跨会话/跨用户 403 `foreign-ticket`；跨租户认证层 401"，记 D-5。

### AR-52（P2，登记）· 覆盖率台账不认本机数

`docs/coverage-baseline.json` 的 note 明确"只认 CI（Ubuntu）口径"，本机 Windows 的
v8 分母会虚高约 1900 行。TA-54 要求"台账同步更新"与这条自我约束冲突。
**处置**：台账不动；新增 `coverage-auth.txt` 记录本次本机读数（auth/authz ≥90% 的判据），
全仓数仍引 CI 台账。记 D-6。

### AR-53 ~ AR-58（登记）

- **AR-53**：`saga.tenant` 是**告警**不是锁；两个租户共用部署根仍会共库。计划要求 warn，
  实现照做；`docs/tenant.md` 把"不同 `--jsonl`/工作目录"写成部署纪律。
- **AR-54**：`--keep` 只保留目录，进程在退出时关闭；答辩现场若要看运行中的两进程，用
  `docs/tenant.md` 的两条启动命令。
- **AR-55**：判据 1 的"文件含 tenant 就跳过"是粗筛；精确豁免只有两条，理由在代码里。
- **AR-56**：反代告警是"配置提示"，不是反代检测；不实现 XFF 是计划决策。
- **AR-57**：matrix 用 stress 档（u-1/u-2）才能证明"不同 userId 不交叉"；demo 档只有一个用户。
- **AR-58**：`audit replay` 缺省 demo 改变了旧平铺目录的行为；01 已完成迁移，文档/测试同步。

---

## 4 怀疑过、但证伪了

| 怀疑 | 证伪方式 | 结论 |
|---|---|---|
| M3 证明了"票据归属校验" | 代码路径：acme 的 pending 表没有该 ticketId → 必然 404；断言写死 `unknown-ticket` | 只证明进程内存不共享（已在文档/答辩卡写明） |
| M4/M5 的 grep 会被目录路径误报 | 搜索的是**租户根之内**的文件内容，路径不进内容；实测 0 命中 | 不是误报 |
| 两个租户同 `--jsonl` 会静默共库 | `saga.tenant` 标记 + warn；matrix 用不同 root 避开 | 有告警，但不是强制 |
| 门禁的 `fileOf` 是公式复刻 | 判据 2/3 真 `boot()` 两次取 `SESSION_FILES.fileOf` | 不是复刻 |

---

## 5 不声称

- 不声称"一进程多租户"：ADR-0004 明确不做。
- 不声称"跨租户 404"：认证层 401，资源层不可达。
- 不声称"M3 证明了票据归属"：只证明两进程 pending 表不共享。
- 不声称"全仓覆盖率 88.32% 是 CI 口径"：那是本机读数；台账仍 91.14%（CI）。
- 不声称"`saga.tenant` 强制隔离"：它只告警。
