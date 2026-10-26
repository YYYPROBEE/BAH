# 接下来的施工计划（2026-10-23 起 → 11-02 冻结）

> 起草：2026-10-23 00:40 ｜ 复审：00:55（`review-next-actions-2026-10-23.md`）｜ 拍板：00:42
> **融合：00:58，吸收 `文档归档/BAH下一步施工总案-2026-10-23.md` 的 6 条补丁（见 §5）**
> 基线：`HEAD 0cd4a5d` + 13 项未提交改动
> 口径：单人对付，10-23 … 11-01 十个工作日 + 11-02 上午冻结
> 2026-10-24 更新：用例数与安全口径以 `facts.md` 为准；CSP/限流/演示独立目录已补，文中旧数字与旧缺口为历史记录。

---

## 0. 一句话

**先清障，再修四个"评委一眼能看见"的假象，然后堵 fail-open。演示走真实模型 + router 兜底。**

四条底线：**收口入库、演示不撒谎、HP-0 fail-closed、五类交付物**。
HP-3、HP-4 砍；**HP-2 也砍**（理由见 §3 第 9 条）；HP-1 以 S-1 形态保留。

---

## 1. 实测现状

### 1.1 仓库与门禁

| 项 | 实测 | 影响 |
|---|---|---|
| `git status` | **13 项未提交**，含 `packages/eval/`、`packages/memory-store/`、`saga-bridge.ts` | `git ls-files` 计数 **0**，实物只在本地 |
| `pnpm gate` | 27 项，**3 红**：`verify-saga-wiring`（缺 `export { gate }`）、`snapshot-fresh`、`tracked-sources` | `tracked-sources` 入库自愈；`snapshot-fresh` 要重录场景 |
| `git remote` | `origin` 已有，仓库**私有** | 私有仓地址评委打不开；D10 做公开预检保出口 |
| 交付物 | 无 README；`deploy.md` / `security-self-assessment.md` / `facts.md` / 三件套 全缺 | 致命 |
| HP 施工单 | 只有 hp-0；HP-1/2/3/4 未写 | 只需为 HP-0、S-1 各写精简版 |
| 模型接入面 | `ModelSettings.provider: 'mock' \| 'deepseek'`，`apiKeyEnv` 默认 `DEEPSEEK_API_KEY`，`baseUrl` / `requestTimeoutMs` 可配 | **切真实模型是配置级的，不改代码** |

### 1.2 四个"演示当场能看见"的缺陷（全部回源码核实）

| # | 缺陷 | 证据 | 后果 |
|---|---|---|---|
| **D-1** | **演示是固定磁带** | `packages/llm/src/mock/adapter.ts:131` `resolveStep(this.script, this.cursor)`，不读 `call.messages`；`profiles/{web,headless}/patch.yml` 写死 `script` | 评委问任何剧本外的问题，回答都是同一段话 |
| **D-2** | **拒绝后仍称成功** | 两份 patch 的 script 第二段是死文本「已为你在模拟环境完成 800 元转账（黄色级别，已审批并核销）」 | 点"拒绝"→ 工具失败 + 助手说"已完成"，违反赛题 §3.2 |
| **D-3** | **金额差 100 倍** | 发射端 `packages/bank/src/tools/governance.ts:367` 发元；消费端 `packages/channels/src/web/audit.ts:77` `formatCents(amount)` 当分；`amount.ts:5-6` 注释与生产端相反 | 审批弹窗把 800 元显示成 **¥8.00** |
| **D-4** | **零签名报 verified** | `packages/persistence/src/chain/audit-report.ts:100` `if (coverage.signedExpected === 0) return { signatureState: 'verified' }` | 自评写"审计链已验签"是假话 |

### 1.3 阈值语义（不是简单改数字）

- `DEFAULT_BANK_TOOLS.dailyTransferLimit = 5_000`（元，`bank-tools.ts:88`），赛题要 **1000**。
- 判红走 `min(preview.dailyLimitCents, Config)`（`tier.ts:121-128`），超限 = `warn` → 治理层升红走审批，**不是硬阻断**。
- `preview.remainingCents` 用 mock 卡限额 **500 000 分**，只改 Config 会出现"界面说还能转 5000，转 1200 就弹红级"。两处同改。

---

## 2. 账本（第三轮，按 00:56 的三个选择重算）

| 项 | 内容 | 人日 |
|---|---|---|
| 收口 | 3 提交入库 0.25 + `verify-saga-wiring` 补 gate 0.25（`tracked-sources` 自愈） | **0.5** |
| HP-0 | fail-closed 0.5 + web-admin 0.35 + CLI 0.35（合并重录摊入） | **1.5** |
| 阈值 | Config + 卡限额 + 测试 | **0.5** |
| **D-1/D-2 演示真实性** | 兜底 router 0.6 + 真实模型配置 0.25 + 条件化收尾文案 0.15 + 金额单位 0.5 | **1.5** |
| **D-4 审计诚实化** | `unsigned` 状态 + 测试 + `docs/audit.md` | **0.25** |
| **Web 鉴权最小集** | Bearer token 401 + 票据 `randomUUID` | **0.5** |
| **S-1 行动断言守卫** | 成功断言 vs 本 turn 工具结局对账，block + nudge；2 条负向用例 | **0.5** |
| **三处小洞** | 审批弹窗补手机+费用 0.25 / health 去票据 ID 0.1 / `emitIsolated` 0.25 | **0.6** |
| 交付物 | facts+README（含架构/算法/安全三章）0.9 / deploy 0.35 / 安全自评 0.65 / 简介 0.25 | **2.15** |
| PPT / 最小评测 / 视频 / 终检 / 冻结 | 0.6 + 0.25 + 0.5 + 0.25 + 0.25 | **1.85** |
| ~~HP-2 缩小版~~ | 见 §3 第 9 条 | **0** |
| | **合计** | **10.35** |

可用 **10.75** → **缓冲 0.4 天**。这是三轮下来唯一还有余量的版本。

---

## 3. 拍板记录

| # | 议题 | 决议 | 时点 |
|---|---|---|---|
| 1 | 砍单范围 | 四件全做 → **吸收总案后修正**：HP-0 全做、HP-1 退化为 S-1、HP-2 只做 TS 验签、HP-3/HP-4 砍 | 00:42 / 00:58 修正 |
| 2 | 入库拆分 | 拆 3 个提交（eval / memory-store / saga-bridge） | 00:42 |
| 3 | 仓库公开 | 保持私有，提交时给权限；D10 做公开预检 | 00:42 |
| 4 | 最后两天投向 | HP-1 最小值（= S-1） | 00:42 |
| 5 | 演示真实性 | **升为底线**，优先于 HP-1 之后的一切机制增量 | 00:58 |
| 6 | 金额单位 / 零签名 | 必做，0.75 天，不许挤掉 | 00:58 |
| 7 | 演示模型 | **真实模型为主 + router 兜底**（`provider: deepseek`，断网降 mock） | 00:56 |
| 8 | 三处小洞 | **全补**（审批要素 + health 去票据 ID + `emitIsolated`），0.6 天 | 00:56 |
| 9 | HP-2 半成品 | 你选"保留"，**我改判为砍**——理由见下 | 00:57 |

**第 1 条的修正理由**：吸收 D-1~D-4 需 3.0 天，超出 10.75 的容量。
HP-3（HALT 解除）和 HP-4（输出契约）是"答辩时讲的设计"，D-1/D-2 是"演示时当场被看穿的假象"。

**第 9 条改判的理由**（这是我唯一推翻你选择的地方）：

1. 三轮账算下来，11.3 人日 vs 10.75，超 0.55。所有可以压缩的"表达层"（PPT / 视频 / 自评 / 评测）加起来只能挤出 0.55，
   正好把缓冲吃干；而 HP-2 是账上**唯一一整块、且砍了不影响演示与交付物**的 0.7 天。
2. 演示主路径改成真实模型后，主场景是转账；知识问答不在演示里，**验签门在整场答辩中零可见度**。
3. "能说 TS 侧验签门已接"的前提是有人问。主演示不问 RAG，这 0.7 天换不到任何一分；
   反过来，若评委真问 RAG 安全，答案是"验了 TS 侧、RAG 侧还没签"——自己说出来的缺口比不说更被动。

**如果你坚持保留 HP-2**：替代代价是 PPT 压到 6 页 + 视频压到 2 分半 + 安全自评去掉风险表细节（合计 0.7）。
我的判断是那份风险表比验签门值钱——它是被追问时的护身符。

---

## 4. 逐日表

### D1 · 10-23｜收口（0.5d）

| # | 动作 | 出口 |
|---|---|---|
| 1 | 3 个提交入库：eval / memory-store / saga-bridge（含 patch 与 lockfile） | `git ls-files packages/eval` 非 0；`tracked-sources` 自绿 |
| 2 | `verify-saga-wiring.ts` 补 `export { gate }`，顶层副作用收进 `run()` | 该项绿，`import` 不触发转账 |
| 3 | `bank:saga-bridge` 纳入对应场景 `coveredSources`，重录 + 复核 diff | `snapshot-fresh` 绿 |
| 4 | `pnpm gate` 全量 | **27/27**（保持 27 项，不采用改名方案，见 §5.2） |

### D2 · 10-24｜HP-0 上半 + 阈值（1.5d）

| # | 动作 | 出口 |
|---|---|---|
| 1 | `fail-closed.ts` + 单测 + `sentry/verifier-failed` 事件 + `pipeline/index.ts` 换注册 | HP0-01/02/03 |
| 2 | 阈值 `5_000 → 1_000`（元）+ mock 卡限额同步 + `sentry.test.ts` 5001→1001 | 1000 不升红 / 1001 升红 |

### D3 · 10-25｜演示真实性（1.5d）

| # | 动作 | 出口 |
|---|---|---|
| 1 | **主路径切真实模型**：`profiles/web/patch.yml` 改 `provider: deepseek` + `apiKeyEnv`；`requestTimeoutMs` 收紧 | 一句话触发 preview→create，回答由模型生成 |
| 2 | **兜底 router**（落 `packages/llm/src/` 下新建 demo 目录）：两条分支——余额类、转账类；识别不到就追问 | 断网切 mock 后仍能跑通主场景 |
| 3 | **收尾文案由本 turn `tool/result` 生成**：成功才说"已完成"；`isError` / `approval-rejected` 必须说"未执行：<原因>" | 拒绝 → 回复不含"已完成" |
| 4 | 金额单位：`audit.ts:77` 改 `formatCents(amount * 100)` + 修 `amount.ts` 注释 + 跨层用例 | 800 元显示 ¥800.00 |
| 5 | 剧本补 `transfer_preview`（现在直调 `transfer_create`，演示跳过预览环节） | 演示走 preview→create 两步 |

### D4 · 10-26｜HP-0 下半 + 审计诚实化（1.25d）

| # | 动作 | 出口 |
|---|---|---|
| 1 | `web-admin.ts` + `web.ts` 挂 `POST /api/admin/sentry/unfreeze` | HP0-05…11 |
| 2 | `cli/sentry.ts` + 命令路由 + HELP | HP0-12…15 |
| 3 | `docs/sentry.md`（异常=不可信；**headless 无远程解冻**）+ `docs/web-frontend.md` | 两处落地 |
| 4 | 一次合并重录 + `pnpm test:web` | gate 27/27 |
| 5 | `audit-report.ts:100` 零签名 → `unsigned` + 测试 + `docs/audit.md` | 不再假 verified |

### D5 · 10-27｜鉴权 + S-1（1.0d）

| # | 动作 | 出口 |
|---|---|---|
| 1 | `web.ts` Bearer token：无凭证 POST → 401；`GET /api/session`、`GET /api/events` 同样保护 | 未带凭证 → 401 |
| 2 | `pipeline.ts:423` 票据 ID `ticket:${callId}` → `ticket:${randomUUID()}` | 票据不可预测 |
| 3 | S-1 行动断言守卫：`已完成/已转账/已核销/办理成功/到账` 与本 turn 工具结局对账，不一致 → block + nudge；**自包一层 fail-closed**（turn-stopping 崩了不许放行） | 注入假文案 → 被 block；2 条负向用例 |

### D6 · 10-28｜三处小洞 + facts（0.85d）

| # | 动作 | 出口 |
|---|---|---|
| 1 | `ApprovalFrame` 补 `payeePhone`（脱敏）+ `fee`（来自 preview） | 弹窗显示姓名+脱敏手机+费用 |
| 2 | `web.ts:305-309` health 只返回票据**数量**，不返回 ID 列表 | 探针拿不到票据 |
| 3 | `session/event` 改 `emitIsolated` | 一个记账监听器抛错不阻断后续观察者 |
| 4 | 新建 `facts.md`：三行口径 + 27 门禁 + 14 工具 + 端口 | 后续材料只取这一份 |

### D7 · 10-29｜README + 简介（0.9d）

| # | 动作 | 出口 |
|---|---|---|
| 1 | 根 README：定位 + 架构图（mermaid）+ 四命令 + 14 工具权限表 + **架构/算法/安全三章** | 新机器可复现 |
| 2 | 200 字简介 | ≤200 字 |

### D8 · 10-30｜deploy + 安全自评（1.0d）

| # | 动作 | 出口 |
|---|---|---|
| 1 | 新建 `deploy.md`：版本、两端口、环境变量（含 `DEEPSEEK_API_KEY`）、故障排查、`demo.mjs` | 从零起得来 |
| 2 | 新建 `security-self-assessment.md`：三级矩阵 + 四种升级理由 + 票据五绑定 + **已知风险表**（§5.4 清单） | 覆盖赛题 §3.1/§3.2 |

### D9 · 10-31｜PPT + 最小评测（0.85d）

| # | 动作 | 出口 |
|---|---|---|
| 1 | 最小评测：M0 判定器跑 3 场景（查余额 / 转账批准 / 拒绝），`fixedClock` 固定时序 | 3 行数字可复现，落 `审计-2026-10-23/` |
| 2 | PPT 12 页，数字全部来自 facts.md | ≤10 分钟 |

### D10 · 11-01｜视频 + 终检 + 公开预检（0.75d）

| # | 动作 | 出口 |
|---|---|---|
| 1 | 视频 ≤5 min：**必须拍到真实的拒绝画面**（点拒绝 → 助手说"未执行"），一镜到底不剪接 | mp4 可播 |
| 2 | 终检 + 五类资料映射 | 产物存 `审计-2026-10-23/logs/` |
| 3 | 公开预检：`docs/` 扫内网路径 / 真实姓名 / 评审内稿 | 若需转公开，随时可执行 |

### D11 · 11-02｜冻结 + 报名系统提交（0.25d）

`v1.0-submit` tag + 推送 + **到报名系统上传 PPT/视频/简介并填表**。不开工新项。

> 赛题 §五写的是"前往大赛报名系统提交"，不是"打个 tag"。上传可能排队，别留到最后半小时。

---

## 5. 与总案的分歧（吸收什么、不采什么、改什么）

### 5.1 吸收（6 条，全部回源码核实过）

| # | 总案发现 | 我原先的漏 | 落点 |
|---|---|---|---|
| 1 | 演示是固定磁带（adapter 不读消息） | 完全没提 | D3 |
| 2 | 拒绝后仍称成功（剧本写死文案） | 完全没提 | D3 |
| 3 | 金额单位 100 倍差（元/分混用） | 复审报告提过一句，没进计划 | D3 |
| 4 | 零签名报 verified | 完全没提 | D4 |
| 5 | `turn-stopping` 也要 fail-closed | HP-0 只护 post-execute，行动断言守卫挂在 turn-stopping，那里崩了仍放行 | D5 的 S-1 自包一层 |
| 6 | `headless` 的 `autoDecision: allow` 是演示风险 | 没提 | D3 改为默认 reject，演示走 Web 弹窗 |

### 5.2 不采（2 条，附理由）

**不采 1：`verify-saga-wiring.ts` 改名 `probe-*`（门禁 27 → 26）**

总案的理由是"它会 boot 整个应用并真跑一笔转账，不适合作为自动门禁"。
问题不在"它是门禁"，在**顶层副作用**。项目里 27 个 gate 全部是
`export { gate }` + `if (isMainModule(...)) runStandalone(gate)` 的模式，加这个不是特例。
改名会让"Saga 通电"从门禁里消失，以后没人跑——那正是它当前唯一的价值。
**改法**：补 `export { gate }`，把 `boot()` / `agent.send()` / `agent.run()` 全收进 `run()`，门禁数保持 27。

**不采 2：HP-0 默认不做**

用户已拍板保留。补一条理由：HP-0 与 D5 的 S-1 共用同一个 fail-closed 语境，
`sentry/pipeline` 一旦有了 `failClosedPostExecute`，S-1 挂在 turn-stopping 上可以直接复用这个包装器，
边际成本比单独写低。

### 5.3 改（1 条）

**`facts.md` 的门禁数写 27，不是 26**（因为不采纳改名方案；第 27 支是 `verify-no-left-accent`）。
另外 facts.md 必须分三行口径：`pnpm test`（主仓）/ `pnpm -F @bah/eval test`（评测包）/
`pnpm test:web`（前端）——eval 的 133 用例不在根 vitest include 内，写成一个总数会被问穿。

### 5.4 安全自评的已知风险表（必须写，不写会被追问）

- 无真实登录/用户认证，当前是本机单用户演示；Web 只有 Bearer token（2026-10-24 已补 CSP/XFO/XCTO/Referrer-Policy/Permissions-Policy）
- 强验证 Provider 全 mock（短信/人脸/U盾语义位齐，未接真实渠道）
- 银行账本为内存仿真，进程重启回种子；不宣称持久
- 审计链只保证链内自洽，覆盖 Saga 状态迁移；零签名状态已改 `unsigned`
- **HP-3 未施工**：只有 breaker 熔断，无人工解除面；headless 只能重启
- **HP-4 未施工**：14 个工具只有入参契约，无出参契约
- **HP-2 未施工**：RAG 响应签名与 TS 验签门都没做；知识侧只有 ACL + 时效窗 + 引用/数值校验
- **DAG 规划未实现**：`runtime/src/{plan,goal,todo,scope}` 是占位；Saga 两步 DAG 是唯一可演示的规划物
- 卡片挂失/解挂、密码修改未实现
- 补偿止于"决策 + 人工核销"，银行核心无冲正接口
- 记忆层内核完成（40 用例）但未进演示路径
- 注入检测只记分不阻断，`riskScore` 无生产消费点
- 单会话、无多租户；Web `/api/*` 为单机级 60s/120 次限流（不是网关/WAF）
- 演示主路径依赖真实模型端点；断网时降级到 router（`mock` provider）

---

## 6. 降级登记

### 6.1 四件的实际形态

| 件 | 原出口 | 实际交付 |
|---|---|---|
| HP-0 | HP0-01…15、覆盖 100% | **全做**，不降级 |
| HP-1 | lineage 模块 + 10 用例 + 传播抑制 | **退化为 S-1**：成功断言 vs 工具结局对账，2 条负向用例；无 `evidenceRefs` 结构 |
| HP-2 | 5 种失败 + 跨语言黄金向量 | **砍**（§3 第 9 条），自评登记"未施工" |
| HP-3 | HALT + 票据 MFA 解除 | **砍**，自评登记 |
| HP-4 | 6 个 P0 工具契约 | **砍**，自评登记 |

### 6.2 两处契约让步

1. **三件套技术文档 → README 三章**（赛题 §五.2 要三份独立文档）。内容都在，若严格计数会被扣。
2. **Web 鉴权只做 Bearer token + 票据 UUID**，不做 Origin 校验、Content-Type 校验、CSP、安全响应头。
   本机回环演示下风险低，自评如实写。

### 6.3 超时后的让步顺序（依次执行）

1. PPT 压到 8 页、视频压到 3 分钟 → 省 0.4d
2. 安全自评压到"三级矩阵 + 风险表"两节 → 省 0.25d
3. 最小评测 3 场景降为 1 场景（只留"拒绝"）→ 省 0.15d

**绝不砍**：收口、D-1/D-2 演示真实性、HP-0、D-3 金额单位、三处小洞、五类交付物、`facts.md`。

---

## 7. 执行陷阱

1. **快照重录必须等基线干净**，否则 diff 里混着别人的改动，无法归因。
2. **`web-admin` 不许硬依赖 sentry**：惰性 `ctx.get(SENTRY_SERVICE)` + 捕获异常，
   否则没有 sentry 的 profile 起不来。
3. **文档门禁扫 `docs/*.md` 的反引号路径**：规划中的路径放进围栏代码块，正文用短名。
4. **阈值改两处**：判红用 `min(卡限额, Config)`，但 `preview.remainingCents` 用卡限额。
5. **demo router 的注册点不止 adapter**：`model.ts:47` 的 provider enum + `DEFAULT_MODELS` + 两份 profile patch，
   写完 adapter 不等于接上。

---

## 8. 现在就能跑的五条命令

```bash
# 1. 有多少东西没入库
git status --short && git ls-files packages/eval packages/memory-store | wc -l

# 2. 基线红在哪三项
pnpm gate 2>&1 | tail -40

# 3. HP-0 入口确实还不存在
ls packages/safety/src/sentry/pipeline/fail-closed.ts \
   packages/host/src/boot/plugins/web-admin.ts \
   packages/cli/src/cli/sentry.ts 2>&1

# 4. 阈值当前值
grep -n "dailyTransferLimit" packages/host/src/boot/plugins/bank-tools.ts

# 5. 演示确实是磁带（看 script 与 cursor）
grep -n "cursor\|resolveStep" packages/llm/src/mock/adapter.ts
```

---

## 9. 三份文档的关系

| 文档 | 关系 |
|---|---|
| `docs/hp-0-fail-closed.md` | **原样执行**，不改规格；排进 D2 / D4 |
| `docs/review-next-actions-2026-10-23.md` | 我的双角度复审：3 处契约违约、4 处工程误判 |
| `文档归档/BAH下一步施工总案-2026-10-23.md` | **吸收了 6 条**（演示真实性 ×2、金额单位、零签名、turn-stopping fail-closed、headless autoDecision）；**不采 2 条**（改名、HP-0 不做） |

---

## 10. D1 执行记录（2026-10-23 01:12 收尾）

### 10.1 实测数字

| 项 | 命令 | 结果 |
|---|---|---|
| 门禁 | `pnpm gate` | **27/27** |
| 主仓测试 | `pnpm test` | 155 文件 / **1394 用例**全通过 |
| 类型 | `pnpm typecheck` | 通过（修掉 `model.test.ts:80` 一处 TS2322） |
| 快照 | `pnpm snapshot:record` | 14 用例全通过（3 场景重录 + 回放全等） |
| 未跟踪源码 | `git ls-files --others` | **0** |

### 10.2 八个提交

```text
4d0046b test(host): 补条件收尾的订阅接线用例，修 SessionId 品牌类型
a39c5b4 docs: 施工总案、双角度复审与 HP-0 施工单入库
d376ee8 style(web): 工具卡三态由左侧色带改为整圈描边
ecc0f5c test(snapshot): 三个场景按当前装配重录，补上 Saga 预检与条件收尾
3b1d8bc fix(knowledge): http 端口按线上契约裁剪请求体，不再原样透传
671daba chore(profiles): 条件收尾脚本 + 压缩阈值 + 环境声明 + web 知识行
fa4b366 feat(llm): mock 脚本支持按本 turn 的 tool/result 结局条件收尾
6510c82 chore(repo): 把盘上未入库的三个模块与三支脚本入库
```

### 10.3 与计划的四处偏差（都要按新事实读后续文档）

| # | 计划说法 | 实际 | 原因 |
|---|---|---|---|
| 1 | 门禁 26 项 | **27 项** | `verify-no-left-accent` 是第 27 支；`AGENTS.md` 早已写 27 |
| 2 | 入库拆 3 个提交 | **1 个提交** | `pre-commit` 跑 gate，`tracked-sources` 用 `git ls-files --others`；部分提交走临时索引，其余新源码被重新判成"未跟踪"，前两笔必红 |
| 3 | D-2 条件收尾排 D3 | **代码已在 D1 入库** | 盘上已有 `outcome` 全套（`script.ts` / `adapter.ts` / `model.ts` / 两份 profile），只缺类型用例 |
| 4 | 修 `verify-saga-wiring` 只是"补 `export { gate }`" | 真问题是**顶层真转账** | `run-gates` 先 `import` 再读 `{ gate }`，导入即执行；现已收进 `run(root)`，实测导入后 `sessions/saga.sqlite` 大小与 mtime 不变 |

### 10.4 本批新增的已知风险（进安全自评）

- **门禁会写库**：`verify-saga-wiring` 每跑一次真的转一笔 800 元，写进跨运行持久的
  `sessions/saga.sqlite`（现已累积 40+ 笔）。门禁本身是绿的，但 D10 终检前必须清库，
  否则演示日志里会有一堆来历不明的事务。
- **门禁抖动一次**：8 次提交里 `saga-wiring` 红过 1 次，单独重跑即绿，未定位根因。
  若后续复现，优先查 `sessions/saga.sqlite` 的并发锁与 `.tmp-saga-wiring` 的清理时序。
- **D-2 只修了一半**：收尾文案已按结局分支，但演示主路径仍是 `provider: mock`。
  D3 的"真实模型 + router 兜底"一项未动。
- 快照的 `outcome` 只覆盖**成功分支**；"拒绝 → 未执行"这条分支至今没有快照背书，
  靠 `model.test.ts` 的单测兜着。D3 必须补 web 拒绝场景。

---

## 11. D2 执行记录（2026-10-23 01:30）

### 11.1 完成面

| 计划项 | 实际 | 说明 |
|---|---|---|
| HP-0 上半（fail-closed） | **HP0-01…04 全做** | 计划只写到 01/02/03；04（sentry 集成）一并补了 |
| 事件 `sentry/verifier-failed` | 已声明并落账 | `ignorable: true`；门禁实测"声明事件 54 个" |
| 阈值 5000→1000 | 已完成 | 判决与预览**同源**，见 §11.2 |
| D-3 金额单位（提前） | 已完成 | 计划在 D3，实际在 D2 顺手做掉（同属"演示当场能看见"） |

实测：`pnpm gate` **27/27**；`pnpm test` 156 文件 / **1406 用例**；`pnpm test:web` 46 用例；
`pnpm typecheck` 通过；`packages/channels` 57 用例。

### 11.2 一个改法上的选择（与原复审建议不同）

复审给的两条路是"把 mock 卡日限额一并降到 1000"或"让 preview 也取 min"。**选了后者**：

```text
改前：dailyLimitOf = 卡限额 ?? 全局阈值        → 有卡就只看卡
改后：dailyLimitOf = min(卡限额, 全局阈值)     → 两者都成立时取交集
```

理由：卡限额是**产品维度**（这张卡能转多少），全局阈值是**风控维度**（今天允许转多少）。
改数据集里的卡限额只是把两个数暂时凑成一样，下次有人调 Config 还会再裂一次；
取 min 之后**只调 Config 一处，判决与展示一起动**，且卡片限额的产品语义保住了。

副作用：`bank` 既有用例全部仍绿（默认两者都是 5000，min 不改变结果）。

### 11.3 快照重录 diff（4 行/场景）

```text
dailyLimitCents:  500000 → 100000
remainingCents:   500000 → 100000   （preview）
remainingCents:   420000 →  20000   （转 800 后：1000−800 元）
effectiveTier:    yellow → yellow   （不变，800 ≤ 1000）
```

`llm.jsonl` 一字节未变。这是"只改了口径、没改模型可见面"的证据。

### 11.4 三条要登记的偏差

1. **HP0-04 的断言比规格弱**：规格说"结果不进入模型可信内容"，但 `ctx.events.waterfall`
   只返回判决，content 的替换发生在七段管线的 block 分支。所以集成用例断言的是
   `verdict.reason` 是固定话术、且不含原始结果文本；content 替换由既有的 pipeline 用例兜。
   这不是偷工，是分层事实——写清楚比假装测了更安全。
2. **门禁逼着改了实现**：`single-error-normalization` 报"重复实现 messageOf"，
   于是改用 `@bah/util` 的 `reasonOf`。这是门禁起作用的例子，不是障碍。
3. **D3 仍未做的一半**：真实模型（`provider: deepseek`）、断网 router 兜底、
   剧本补 `transfer_preview`、web 拒绝场景的快照背书。演示主路径现在仍跑 mock。

### 11.5 新增风险

- **门禁写库的问题没解决且更明显**：`sessions/saga.sqlite` 现在 45+ 笔，
  每条提交都在加。D10 终检前必须删库重建，否则演示日志里全是历史事务。
- **`verifier-unavailable` 没有端到端演示路径**：fail-closed 只有单测与集成用例，
  没有一条"故意让判决件崩掉"的演示脚本。答辩若被追问"怎么证明它真的会拦"，
  现在的答案是"跑那条单测"，不是"点一下给你看"。D9 的最小评测可以补一条。

---

## 12. D3 执行记录（2026-10-23 02:00）

### 12.1 D-1「固定磁带」已修，两条路都实测过

| 路径 | 配置 | 实测 |
|---|---|---|
| **真实模型**（主路径） | `provider: deepseek` + `baseUrl` → DashScope 兼容端点 + `qwen-plus` | 两轮真跑：①"帮我查下余额" → 模型自选 `account_list` → 答"3 个账户，可用合计 ¥13,234.55"；②"这个月我花在餐饮上多少钱？顺便说说该注意什么" → 模型自选 `bill_analyze` → 答"餐饮 ¥524.00，占 38.7%…建议关注消费结构" |
| **离线路由**（兜底） | `provider: router` | 快照/门禁全绿：查余额走 `account_balance` + 复述工具结果；转账走 preview→create；认不出的问题追问 |

第②条是决定性的：**那句话不在任何脚本里**，模型自己选了工具、读了结果、给了建议。
D-1 的证据（"评委问剧本外的问题，回答都是同一段话"）到此失效。

### 12.2 一个关键取舍（与计划不同）

计划写的是"真实模型为主 + 断网降 mock"。实测后改成 **"真实模型为主 + 断网降 router"**：

- `mock` 的固定脚本正是 D-1 的病灶，把它当兜底等于"网络一断就退回假象"；
- `router` 是同一份 `MockLlmAdapter` 加一个读消息的 `plan`，确定性、无网络，
  但不会答非所问——兜底不该比主路径更会撒谎。

另：这台机器上**没有 DeepSeek 官方密钥**，只有 DashScope（千问）的。
`deepseek` 适配器本就是 OpenAI 兼容协议，指 `baseUrl` 过去即可，
并用新增的 `modelSpec` 显式声明能力位（内置表只有 DeepSeek 两个 id，不猜）。

### 12.3 新增的三样东西

1. **`packages/llm/src/demo/`**：意图识别 + 步骤规划（14 条用例）。明确不猜意图：
   抽不出金额/收款人就追问，不给默认值——转错人是真钱。
2. **`reflect` 步**：把工具结果正文原样作为回复。查余额唯一诚实的答案是工具那串数字，
   让 mock 自己编一句"您的余额是…"等于把幻觉写进脚本。
3. **`packages/llm/src/llm/turns.ts`**：区分"平台注入的 runtimeContext"与"用户真的说了话"。
   这是本轮唯一一个**第一次跑就踩到**的坑：按"最后一条 user"分段，每个 step 都清零，
   模型永远停在第 1 步。

### 12.4 快照重录 diff（要点）

```text
headless-basic：转账 1 笔        → 查余额（read/balance + reflect）
web-channel   ：transfer_create  → transfer_preview（绿）→ transfer_create（黄，进审批）→ 收尾
usage/summary ：calls 2          → calls 3
```

`approval/asked.amount` 仍是 800（元），审计时间线的 ¥800.00 断言继续有效。

### 12.5 仍未做

- **D-3 第 5 项（剧本补 `transfer_preview`）**：profile 已不再有剧本，
  预览由模型或路由自己决定。web 真实模型是否会稳定走 preview→create，**没有回归保护**——
  只在离线 router 路径上有确定性。
- **拒绝分支的快照背书**：仍然只有单测。D10 拍视频前必须补一条 web 拒绝场景。
- **密钥不进仓库**：`.env.local` 被 `.gitignore` 挡住（实测 `git check-ignore` 命中第 5 行）。
  但 `BAH_MODEL_KEY` 的值在 `D:/项目集/github/github.md` 里是明文，与仓库无关；
  提交物里不出现。

---

## 13. 模型换成 deepseek-v4.1-flash-1017（2026-10-23 02:32）

### 13.1 换的原因与实测

同一把 DashScope 密钥可以调 `deepseek-v4.1-flash-1017`（`/models` 里就有），
协议与 `deepseek` 适配器一致，实测返回标准 OpenAI `tool_calls`。
**换成它，而不是继续用 qwen-plus**：演示讲的是 DeepSeek，模型名与话术一致，
答辩时不会被问"你们说的 DeepSeek 怎么跑的是千问"。

三轮真跑（web profile + `.env.local`）：

| 轮次 | 用户说 | 模型做了什么 | 结果 |
|---|---|---|---|
| 1 | 帮我查下余额 | 并行调 `account_list` + `account_balance` | 表格答出 3 个账户，主账户 ¥12,345.67 |
| 2 | 给王建国转 800 元房租 | 调 `transfer_preview`（绿级）后**停下等确认** | 试算：剩余额度 ¥1,000.00、执行级别「黄」、要求回复"确认转账" |
| 3 | 确认转账 | 调 `transfer_create`（黄级）→ 我点批准 | `transfer/created` → 核销 → 收尾"流水号 t-new-9，扣款后余额 ¥11,545.67" |

第 3 轮里模型还自己生成了 `idempotencyKey`（`zhangsan-rent-…`）——不是我们教的。

### 13.2 这改变了**演示流程**，必须同步到 D7 的脚本

原脚本按"一句话触发转账 → 直接弹审批"写的。真实模型会先试算、再等确认，
所以**幕 3 从 1 次输入变成 3 步**：

```text
① "给王建国转 800 元房租"  → 试算卡（绿级预检、剩余额度、风险结论）
② "确认转账"              → 审批弹窗（黄级，六要素）
③ 点"批准"                → 工具卡完成、票据核销、收尾文案
```

这不是退步：**"先算后办、要人点头"正是要展示的安全设计**。
但它意味着 D7 的 PPT 与视频脚本必须按三步写，不能再写"一句话就转账"。

### 13.3 一个观察：工具参数里的收款人是脱敏的

事件里 `transfer_create.args.payee.name` 是 `王**`，而银行侧执行时还原成"王建国"
（白名单命中 `p-1`），工具结果与审批卡片都显示真名。
这是 sentry 的 PII 脱敏 + 令牌还原在起作用。

**演示时要主动讲这一句**：审计链里看不到完整姓名，但业务侧能正确执行——
否则评委看到 `王**` 会以为流程坏了。

---

## 14. D5 执行记录（2026-10-23 09:46）

### 14.1 完成面

| 计划项 | 实际 | 说明 |
|---|---|---|
| Web Bearer token | **已完成** | 除 `/api/health` 与管理路由外，全部 `/api/*` 先验 `Authorization: Bearer`；缺/错 → 401 `web-unauthorized` |
| 票据 UUID | **已完成**（D5 开始前在盘上） | `ticket:${randomUUID()}`；票据 ID 显式随 `ToolCallContext` / `ToolCallInput` 下传，saga 桥接沿用 |
| S-1 行动断言守卫 | **已完成** | 已转账 / 已核销 / 已办理 / 已完成 与本 turn 工具结局逐类核对；不符 → nudge；同 turn 再犯 → 判停 |
| turn-stopping fail-closed | **已完成** | `failClosedTurnStopping`：核验件抛错 → 固定话术 `stop()` + `sentry/verifier-failed` |

实测：`pnpm gate` **27/27**；`pnpm test` **161 文件 / 1471 用例**；`pnpm test:web` 46 用例；`pnpm typecheck` 通过。

### 14.2 三个实现选择

1. **token 默认可用，但不写死**：`BAH_WEB_TOKEN` 未配置时每进程随机生成，
   服务端在 `index.html` 注入 `<meta name="bah-web-token">`，前端读取后放进请求头。
   同源页面能读到、跨源页面读不到（无 CORS）——这是最小 CSRF 边界，**不是登录**。
2. **SSE 只对它自己放宽**：`EventSource` 不能设请求头，因此只有 `GET /api/events` 接受 `?token=`；
   其余接口不认查询参数。
3. **S-1 的 "block" 是"卡住正常收尾"**：turn-stopping 没有 block 返回值，所以第一次纠正走
   `nudge`（主循环在本 turn 内再跑一个 step）；同 turn 已纠正过仍不改口则 `stop()`。
   两段都有测试：拒绝后称完成 → nudge；重复不改口 → 判停。

### 14.3 复审时改掉的两处

- `assert-never` 门禁发现两个 `switch (claim)` 缺收尾，已改用 `assertNever`。
- `tracked-sources` 要求新文件先 `git add` 才认，已暂存 `web-auth.ts` 与它的测试（未提交）。

### 14.4 新增风险（进安全自评）

- **token 对同机进程不设防**：任何能 `GET /` 的本地进程都能读到 meta 里的 token；
  它挡的是跨源网页与"直接打 API"，不是本机恶意进程。
- **无 Origin / CSP / 安全响应头**（原计划就砍掉）；若页面被 XSS，token 可被读走。
- **SSE 的 token 在 URL 查询串里**：会出现在本机访问日志/浏览器历史的可能性，当前只绑回环，风险接受。

---

## 15. D6 执行记录（2026-10-23 09:49）

### 15.1 完成面

| 计划项 | 实际 | 出口 |
|---|---|---|
| 审批弹窗补手机 + 费用 | **已完成** | `ApprovalFrame.payeePhone`（前 3 后 4）/ `feeText`；弹窗有数据才多两行 |
| health 去票据 ID | **已完成** | 改为 `pendingTicketCount`；测试断言响应里不含 `ticket:` |
| `session/event` 改 `emitIsolated` | **已完成** | 一个监听器抛错，落账与后续观察者都不受影响（新增用例） |
| `facts.md` | **已新建** | 根目录；三行测试口径 + 27 门禁 + 14 工具 + 两端口 |

实测：`pnpm gate` **27/27**；`pnpm test` **161 文件 / 1476 用例**；`pnpm test:web` 47 用例；
`pnpm -F @bah/eval test` **14 文件 / 133 用例**；`pnpm typecheck` 通过。

### 15.2 三个实现选择

1. **手机号在上游脱敏**：帧里只有 `139****2222`，完整号码仍在工具参数/审计事件里（由 sentry 的 PII 令牌化处理），
   前端拿不到原值。
2. **手续费只认预演结果**：从 `transfer_preview` 的结果正文里抽 `手续费 ¥…`，按 `收款人 + 金额（分）` 建索引；
   同一人试算两笔不同金额不会串。没有预演就**不显示**，不从金额/费率反推。
3. **health 只给数量**：探针拿到票据 ID 就能绕过页面直接调审批/验证路由，所以只暴露 `pendingTicketCount`。

### 15.3 复审结论

- 门禁 27/27；docs 路径、事件声明、工具目录均未破。
- `facts.md` 的数字与当日实测一致（主仓 1476 / 评测 133 / 前端 47）。
- 已知脆弱点：手续费解析依赖 `transfer_preview` 正文的现有格式；格式变了会**少一行**，不会显示错数。

---

## 16. D7 执行记录（2026-10-23 09:52）

### 16.1 完成面

| 计划项 | 实际 | 出口 |
|---|---|---|
| 根 README | **已新建** | 定位 / 四命令 / mermaid 架构图 / 14 工具权限表 / 架构·算法·安全三章 / 已知限制 |
| 200 字简介 | **已新建** `docs/简介-200字.md` | **196 字（含标点）** |

实测：`pnpm gate` **27/27**；`pnpm test` **161 文件 / 1476 用例**；`pnpm test:web` 47 用例。

### 16.2 复审结论

- README 内 8 个相对链接逐一存在，无死链；14 个工具名在 README 与 facts.md 各命中 14/14。
- 简介按非空白字符计 196，≤200。
- README 与 facts.md 的口径一致：三项测试分行、不相加；断网兜底明确写"手动改 profile"，不写"自动降级"。
- 安全章把未施工项（HP-2/3/4、无登录、内存账本、mock 强验证）逐条列出，便于答辩时照实回答。

### 16.3 仍未做（按计划留给 D8–D10）

- `deploy.md`、`security-self-assessment.md`（D8）
- 最小评测 3 场景、PPT 12 页（D9）
- 视频（必须拍到真实拒绝画面）、终检、公开预检（D10）
- 冻结 tag 与报名系统提交（D11）

---

## 17. 10-23 午后追加：覆盖率红已闭合，快照红记入待办

### 17.1 `test:coverage` 闭合（提交 `9eb0e2f`）

根因不是代码坏了：`scripts/coverage-allowlist.ts` 把新写的生产代码登记进强制名单，用例没跟上。
156 行未覆盖逐段还原成带上下文的代码核过，**全是兜底与收尾路径，没有一处死代码**，
所以没缩名单、没删代码、没为凑数写假用例。

| 项 | 改前 | 改后 |
|---|---|---|
| 阈值 ERROR | 39 条（15 个文件） | **0 条** |
| `All files` | 未达标 | **100 \| 96.15 \| 100 \| 100** |
| 用例数 | 1476 | **1559（+83）** |
| `pnpm gate` | — | **27/27** |

生产侧只动两处：`observeToolOutcomes` 的 deepseek 分支不再造 `() => []` 这个没人调用、
却在类型上假装"真实模型也有工具结局视图"的假读口；`honesty.ts` 两个封闭联合的
`assertNever` 收尾按仓内已有 5 处的同一约定加 `/* v8 ignore next */` 与理由。
顺带修了一条**假绿用例**：`packages/runtime/src/tools/pipeline.test.ts` 里标题写
"审计通道自身失败"的那条实际只测到会话服务的监听器隔离（`emitIsolated`），
`toHaveBeenCalled()` 断到的是另一条日志；现在它如实断 `bah-runtime:` 前缀，
"审计通道真坏"由新增用例覆盖。

`pnpm check` 现状：typecheck / lint / build / unit / test:coverage / gate 全绿，
e2e 按设计 skip（无 `DEEPSEEK_API_KEY`），`rag:check` 75 passed。**只剩 `test:snapshot`。**

### 17.2 待办：票据 ID 随机化打穿了快照的确定性护栏

> **已修（2026-10-24）**：按下面方案 1 给 `ToolPipeline` 注入 `mintTicketId`
> （生产仍随机、快照按 `callId` 派生），`pnpm test:snapshot` 恢复 14/14，录制件零重录。
> 回执见 `PROGRESS.md` §51。

**现象**（不是抖动，稳定复现）：`snapshots/sandbox-compute` 与 `snapshots/web-channel` 各 2 例红
（T-AUD-005 录制↔回放全等、T-AUD-006 两次回放全等），共 4 例；不含审批票据的
`headless-basic` 绿。差异只落在带 `ticketId` 的 5 类事件上：

```text
#35 approval/asked        录制 ticket:call-2  ⟶ 回放 ticket:d9b55b48-4ead-…
#36 ticket/issued         同上（ignorable 标记帮不上，比较器比的是整行 JSON）
#37 approval/challenge-issued / #39 ticket/approved / #40 approval/decided
```

**根因链**：`7314143`（D5–D7）把 `packages/runtime/src/tools/pipeline.ts:449` 的票据 ID
从 `ticket:${callId}` 改成 `ticket:${randomUUID()}`——理由正确且必须保留
（票据号出现在 `/api/approval/:ticketId` 与审计里，可预测等于拿 URL 当权限）。
但录制件停在 `5d6a9ea` 的旧形状，而 `compareEvents` 刻意"整行 JSON 全等"，
于是 T-AUD-005 必然红；更本质的是 **T-AUD-006 连"两次回放互相全等"都红**——
每次 `mintTicket` 都 mint 新 UUID，说明这条确定性断言与不可预测 ID 在结构上互斥。

**三个方案**（10-23 拍板：本轮不动，先记着）：

1. **harness 注入确定性 ID 源（推荐）**：给 `ToolPipeline` 加可选 `mintTicketId`，
   生产仍 `randomUUID`，快照面注入按 `callId` 派生。现有录制件零重录，
   并把"不可预测属生产、可复现属验收"这条边界写进代码。约 0.5d，含补用例。
2. **比较器归一化 `ticketId`**：只改 `@bah/test-support`，最快，
   但削弱"整行全等＝模型看到的与用户看到的完全一样"这条证据强度。
3. **先注入再按新形状重录**：录制件重写成 `ticket:<确定性值>`，
   代价是改动审计证据基线，答辩时要能说明重录理由。

**为什么现在可以带着它跑**：`pnpm check` 会在 `test:snapshot` 处阻断合并，
所以这条不修，任何依赖 `check` 全绿的验收动作都得手动跳过它——记在 D8 之前处理。

---

## 18. 重排（2026-10-23 22:45）：剩余 9 天，优先级换轴

> 触发：D1–D7 一天内做完，原计划用 7 天。账面从「缺 3 天」变成「多 6 天」，
> 但**计划里没有一项交代这 6 天怎么花**。本节重排，旧 §4 的 D8–D11 被本节取代。

### 18.1 实测（22:45，只列与计划假设不同的）

| 项 | 计划假设 | 实测 | 后果 |
|---|---|---|---|
| `pnpm test` | 1476 用例（`facts.md` 口径） | **164 文件 / 1559 用例** | `facts.md` 落后 83 条；PPT / 自评 / 简介全引它 |
| `pnpm test:snapshot` | D1 已绿 | **4 红 / 14 例**（`sandbox-compute`、`web-channel` 各 2 例），红因是 `ticketId` 每次 UUID | `pnpm check` 卡在最后一步 |
| 推送状态 | D11 再推 | 本地领先 `origin/main` **26 个提交**，`pre-push` 跑 `pnpm check` | **不修快照就推不上去，交付物只在本机** |
| 拒绝分支 | D10 拍视频时补 | 快照只覆盖成功分支；`approval-rejected` 仅单测 | 视频的"真实拒绝画面"没有验收背书 |
| 真实模型回归 | D3 已接 | e2e 唯一用例读 `DEEPSEEK_API_KEY` 且只验流式文本；演示读 `BAH_MODEL_KEY` | **真实模型零自动化保护**，现场靠人眼看 |
| 断网兜底 | "手动改 profile" | `demo-web.mjs:53` 缺密钥时只打印"请把 provider 换成 router"，无开关 | 现场要在 YAML 里改两行 + 重启，且改错一次就是冷场 |
| 技术文档三件套 | 让步成 README 三章 | `README.md` §2 架构 / §3 算法 / §4 安全，共 88 行 | 赛题 §五.2 要"文档"，报名系统可能按件收 |
| `deploy.md` / `security-self-assessment.md` | D8 新建 | 均 **MISS**；后者的旧版只覆盖 audit 插件 | 2 件硬性材料为 0 |
| `plan`/`goal`/`todo`/`scope` | 只登记不实现 | 四个文件各 **7 行**（纯占位） | 赛题 §3.3 第二条直接对应 |
| PPT / 视频 / 最小评测 | D9–D10 | 产物 **0** | 答辩材料 2 件为 0 |

### 18.2 换轴的理由

旧轴是"十天里塞完四件"。这个假设已经不成立，继续按它排会犯两个错：

1. **把富余花在机制上**（HP-2/3/4、eval M1、memory M3）——这三块在赛前**零可见度**，
   评委看不到、PPT 讲不出口，投入不产生分；
2. **把"能推上去"当成 D11 的收尾动作**——实测它被 `test:snapshot` 卡着，
   而它同时是"仓库地址"这一硬性作品的唯一载体。它必须前移，不能压到最后一天。

新轴一句话：**先让交付物不可能缺席，再让现场不可能翻车，最后才谈能力补齐。**

### 18.3 优先级（成本为实测口径，合计 6.05d / 可用 9.5d）

| 序 | 动作 | 成本 | 出口（可验证） | 为什么排这里 |
|---|---|---|---|---|
| **P0-1** | 快照确定性：按 §17.2 方案 1 给 `ToolPipeline` 注入 `mintTicketId`（生产仍 `randomUUID`，快照面按 `callId` 派生） | 0.5d | `pnpm test:snapshot` 14/14；现有录制件零重录 | 唯一的"全链路闸门"，同时解锁推送 |
| **P0-2** | `pnpm check` 十步复跑 + push 26 提交 | 0.15d | 远端 `main` = 本地 HEAD；GitHub 页面可打开 | 26 个提交只在本机 = 单点故障 |
| **P0-3** | 补 `snapshots/web-channel` 拒绝场景（批准→拒绝→"未执行：<原因>"）+ 真实模型 20 轮压测，成功率写进 `facts.md` | 1.0d | 拒绝分支有快照背书；20 轮有数字 | 视频必拍"真实拒绝"；现场靠真实模型，没数字就是赌 |
| **P1-1** | 离线开关：`pnpm demo:offline`（overlay 切 `router`，不手改 YAML）；e2e 认 `BAH_MODEL_KEY` 作 fallback | 0.4d | 断网一条命令起演示；`pnpm test:e2e` 能真跑 | 现场最可能出的事故是网络，不是代码 |
| **P1-2** | `deploy.md`：版本、两端口、环境变量、故障排查、五条命令 | 0.35d | 新机器照文档起得来 | 赛题 §五.4 硬性项 |
| **P1-3** | `security-self-assessment.md`：三级矩阵 + 四种升级 + 票据五绑定 + **已知风险表**（含 DAG 未实装、无登录、内存账本、mock 强验证、`--no-verify` 可绕过） | 0.65d | 赛题 §3.1/§3.2 逐条可对 | 硬性项；被追问时的护身符 |
| **P1-4** | 三件套拆三份独立文档（`docs/architecture.md` / `algorithms.md` / `security-design.md`），README 三章降为摘要 + 深链 | 1.0d | 报名系统按件上传不卡壳 | **撤销 §6.2 的最大契约让步**——富余 6 天，让步的理由（省 1 人日）已不成立 |
| **P2-1** | 校准 `facts.md`（1559 用例、快照 14、e2e 口径），再跑最小评测 3 场景 | 0.35d | PPT 每个数字都能一条命令复现 | 数字源已过期，先校准再写材料 |
| **P2-2** | PPT 12 页，按**三步转账**（试算→确认→审批）改写 | 0.6d | ≤10 分钟讲完 | 演示流程在 D3 变了，旧脚本作废 |
| **P2-3** | 视频 ≤5 min，一镜到底，**必须含真实拒绝** | 0.5d | mp4 可播 | 硬性项；拒绝是全场唯一无可辩驳的安全证据 |
| **P3-1** | 公开预检（`docs/` 扫内网路径/真实姓名/评审内稿）+ 清 `sessions/saga.sqlite`（门禁每跑 +1 笔 800 元）+ 终检 | 0.3d | 转公开 5 分钟内可执行；审计基线干净 | 私有仓靠"给评委权限"，报名系统不支持就当场转公开 |
| **P3-2** | 10-28 答疑：从已有草案挑 2 问（文档格式 / 仓库可见性 / DAG 判分口径） | 0.1d | 两问发出去 | 唯一能纠正方向性误解的免费机会 |
| **P4** | 冻结 `v1.0-submit`（重打，旧 tag 落后 28 个提交）+ 报名系统上传 5 类材料 | 0.25d | 5 类材料在系统里可见 | 上传可能排队，别留到最后半小时 |

**不排进来的**：HP-2/3/4 复活、eval M1、memory M3/M4、卡片挂失 / 订阅取消。
理由统一：赛前零可见度，且半成品在答辩场是负资产（F-4）。

### 18.4 富余 3.4 天的唯一候选：DAG（时间盒 1.5d，可回退）

赛题 §3.3 三条里，"拆解为有序子任务 DAG"是当前**唯一完全没有实现**的一条，
而 `runtime/src/{plan,goal,todo,scope}` 四个 7 行占位文件摆在源码里，评委翻得到。

做法（窄而真，不动主循环）：

- 只做 `plan`：输入一个多步目标（如"看三个账户哪个够转 800，然后转"），输出**有序子任务表**并逐步执行；
- 落审计事件（`plan/created`、`plan/step-started`、`plan/step-done`），复用现有 event 通道；
- **不新增工具**（否则 14 → 15，`tool-catalog`/`facts.md`/快照/门禁全要同步），
  走新 profile + headless CLI 演示，Web 主路径不动；
- 单测 + 一条快照场景；`goal`/`todo`/`scope` 仍占位，但在自评里**如实写"仅 plan 实装"**。

**回退规则（硬性）**：1.5d 用满仍未过 `pnpm check` → 整件回退（`git revert`），
自评改回"未实装"。不允许为了"看起来有"留半成品。

**为什么不是别的**：这是唯一能同时改善"评分条目覆盖"和"源码观感"的项；
压测与离线开关已经进了 P0-3 / P1-1，不再重复计入。

### 18.5 三条判据（少一条就不算收工）

1. `pnpm check` 十步全绿（含 `test:snapshot` 14/14）——这是"能推、能交、能复现"的唯一凭证；
2. 赛题 §五 五类材料齐备且在报名系统里打得开（简介 / 三件套 / PPT+视频 / 源码+README+部署说明+测试 / 安全自评）；
3. 视频里能看见：点"拒绝" → 助手说"未执行：<原因>"，且这一步不是剪出来的。

### 18.6 与旧 D8–D11 的映射

| 旧 | 新 | 变化 |
|---|---|---|
| D8 deploy + 自评（1.0d） | P1-2 + P1-3（1.0d） | 不变，但前移到 P1 |
| D9 最小评测 + PPT（0.85d） | P2-1 + P2-2（0.95d） | 前面加 0.1d 校准 `facts.md` |
| D10 视频 + 终检 + 公开预检（0.75d） | P2-3 + P3-1（0.8d） | 拆开：拒绝背书前移到 P0-3 |
| D11 冻结 + 上传（0.25d） | P4（0.25d） | 不变 |
| （无） | **P0-1/P0-2/P0-3/P1-1/P1-4**（3.05d） | **新增**：快照、推送、拒绝背书、离线开关、三件套 |
| §6.2 契约让步「三件套 = README 三章」 | **撤销** | 富余使让步失去理由 |

---

## 19. 七项复审记录（2026-10-23 23:05）

> 范围：只审这七项，不扩面（快照确定性、推送、离线开关等留给 P0/P1）。
> 方法：每项回源码 + 跑可执行证据（探针 / 用例），不以文档自述为准。

| # | 项 | 结论 | 证据 |
|---|---|---|---|
| 1 | **D-1 固定磁带** | ✅ 已修复，实测有效 | `mock/adapter.ts` 保留 `script`+`cursor`（快照确定性用）；新增 `plan` 模式读 `request.messages`（`adapter.ts:199`）。探针四种问法给出四种规划：余额→`account_balance`；转账→preview+create+条件收尾；账单/天气→**明确追问**（不是背台词） |
| 2 | **D-2 拒绝后仍称成功** | ✅ 已修复（文案层）+ **本轮补强守卫** | `script.ts:140 resolveOutcome` 按本 turn 最后一条同名工具结局二选一，失败走 `未执行：{reason}`；两份 profile 已无写死 `script`。真实模型路径靠 S-1 兜底，见第 6 项 |
| 3 | **D-3 金额差 100 倍** | ✅ 已修复，口径一致 | `channels/web/audit.ts:83` `formatCents(Math.round(amount*100))`；`amount.ts` 文件头注释已改为"`approval/asked.amount` 是元"；`project.ts:280` 优先取参数字段、缺省才回退事件值。全仓 `formatCents` 调用点只剩 5 处，全部先转分 |
| 4 | **D-4 零签名报 verified** | ✅ 已修复，四层齐全 | `audit-report.ts:112` 零应签 → `unsigned`；用例 `audit-report.test.ts:141`；CLI 把 `unsigned`/`skipped-no-key` 一起判"审计未完成"退出码 2（`cli/audit.ts:337`）；`docs/audit.md:69` 记录第五态 |
| 5 | **Web 鉴权最小集** | ✅ 已落地，覆盖完整 | 每进程随机 token（`web-auth.ts:37`）→ 注入 `index.html` meta（`injectWebToken`）→ 全 `/api/*` 先验 Bearer（`web.ts:403`），SSE 走 `?token=`；比较用 `timingSafeEqual`（`web-admin.ts:76`）。用例：无/错凭证 401 且不触达 agent、`GET /api/session` 同样要求、SSE 无 token 401、health 保持公开 |
| 6 | **S-1 行动断言守卫** | ⚠️ 原实现**有漏判，本轮已修** | 见 §19.1 |
| 7 | **三处小洞** | ✅ 全部补上 | ① `ApprovalFrame` 增 `payeePhone`/`feeText`（`frames.ts:148-150`），手机号脱敏（`amount.ts:75`），手续费只取预览结果（`project.ts:243-250`，"没预演就不显示"）；② health 只返 `pendingTicketCount`（`web.ts:390`，用例 `web.test.ts:231`）；③ `session/event` 改 `emitIsolated` + 错误只留痕（`session/service.ts:84-91`） |

### 19.1 S-1 的三个真实漏判（本轮修的就是这个）

用探针直接喂 `detectActionClaims`，暴露三处（改前 → 改后）：

| 输入 | 改前 | 改后 | 为什么这是漏判 |
|---|---|---|---|
| `审批被拒绝，但转账已完成。` | `[]` | `['transfer']` | 整句含"拒绝"被 `NON_SUCCESS` 放掉；转折句讲的是两件事 |
| `转账已完成，请注意查收。` | `['complete']` | `['transfer']` | 只命中最弱的一类；`complete` 在"有任一成功工具"时不拦——**预览成功 + 创建被拒**正是演示主路径，这句假话原样放行 |
| `已完成转账，待您确认收款。` | `[]` | `['transfer']` | `待`/`需`/`须` 不是否定词，以前被当否定 |

改法（`honesty.ts`）：

1. `CLAUSE_SEP` 增加**逗号与转折连词**（但/不过/然而/可是/却）——按分句判定，不跨句；
2. `NON_SUCCESS` 删掉 `待|需|须`，只留真正的否定；
3. `transfer` 规则补齐"动作名词 + 完成词"的四种说法（`转账已完成` / `完成 800 元转账` / `已转账` / `已到账`）；
4. `complete` 规则改为**必须带办事动词**（办理/操作/交易/业务/申请/申购/赎回），并加 `skip` 排除"查询/查看/检索"——`我已完成查询` 不再被当成办事成功。

新增 2 条用例（含一条集成用例：预览成功 + 创建被拒 + "转账已完成" → 必须 nudge 到"没有成功的转账结果"）。
实测：`honesty.test.ts` 19 → 21 例；`honesty.ts` 覆盖率 100 行 / 93.18 分支；`pnpm test` **164 文件 / 1561 用例**全绿；`pnpm typecheck` 通过；`pnpm gate` **27/27**。

### 19.2 复审中顺带发现的两件事（已处理 / 待拍板）

1. **`docs-paths` 因为我昨天写的计划文红了一次**（§18 引用了三份待建文档）——已按门禁既有机制登记到
   `scripts/docs-path-excludes.ts`，并在条目里写明"落地即删"。现在 27/27。
2. **`profiles/headless/patch.yml` 仍是 `autoDecision: allow`**：§5.1 记录过"改为 reject"的决议，
   但实物没改。**本轮没动**——改了 `headless` 就没法演练"转账成功"那一幕。
   这条属于自评要写的已知风险（headless 自动应答者只在显式配置时生效，默认 `responder: none` = 拒绝），
   建议在 P1-3 安全自评里显式登记，不当成"已修"。

### 19.3 数字口径更新（`facts.md` 已改）

| 命令 | 原记录 | 实测（23:05） |
|---|---|---|
| `pnpm test` | 164 / 1559 | **164 / 1561** |
| `pnpm test:web` | 5 / 47 | **6 / 52** |
| `pnpm -F @bah/eval test` | 14 / 133 | 14 / 133（未变） |
| `pnpm test:snapshot` | 4 红 | **仍 4 红**（`ticketId` UUID，属 P0-1，不在本轮范围） |
