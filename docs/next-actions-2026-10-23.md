# 接下来的施工计划（2026-10-23 起 → 11-02 冻结）

> 起草：2026-10-23 00:40 ｜ 复审：00:55（`review-next-actions-2026-10-23.md`）｜ 拍板：00:42
> **融合：00:58，吸收 `文档归档/BAH下一步施工总案-2026-10-23.md` 的 6 条补丁（见 §5）**
> 基线：`HEAD 0cd4a5d` + 13 项未提交改动
> 口径：单人对付，10-23 … 11-01 十个工作日 + 11-02 上午冻结

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
| `pnpm gate` | 26 项，**3 红**：`verify-saga-wiring`（缺 `export { gate }`）、`snapshot-fresh`、`tracked-sources` | `tracked-sources` 入库自愈；`snapshot-fresh` 要重录场景 |
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
| 4 | `pnpm gate` 全量 | **26/26**（保持 26 项，不采用改名方案，见 §5.2） |

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
| 4 | 一次合并重录 + `pnpm test:web` | gate 26/26 |
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
| 4 | 新建 `facts.md`：三行口径 + 26 门禁 + 14 工具 + 端口 | 后续材料只取这一份 |

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

**不采 1：`verify-saga-wiring.ts` 改名 `probe-*`（门禁 26 → 25）**

总案的理由是"它会 boot 整个应用并真跑一笔转账，不适合作为自动门禁"。
问题不在"它是门禁"，在**顶层副作用**。项目里 26 个 gate 全部是
`export { gate }` + `if (isMainModule(...)) runStandalone(gate)` 的模式，加这个不是特例。
改名会让"Saga 通电"从门禁里消失，以后没人跑——那正是它当前唯一的价值。
**改法**：补 `export { gate }`，把 `boot()` / `agent.send()` / `agent.run()` 全收进 `run()`，门禁数保持 26。

**不采 2：HP-0 默认不做**

用户已拍板保留。补一条理由：HP-0 与 D5 的 S-1 共用同一个 fail-closed 语境，
`sentry/pipeline` 一旦有了 `failClosedPostExecute`，S-1 挂在 turn-stopping 上可以直接复用这个包装器，
边际成本比单独写低。

### 5.3 改（1 条）

**`facts.md` 的门禁数写 26，不是 25**（因为不采纳改名方案）。
另外 facts.md 必须分三行口径：`pnpm test`（主仓）/ `pnpm -F @bah/eval test`（评测包）/
`pnpm test:web`（前端）——eval 的 133 用例不在根 vitest include 内，写成一个总数会被问穿。

### 5.4 安全自评的已知风险表（必须写，不写会被追问）

- 无真实登录/用户认证，当前是本机单用户演示；Web 只有 Bearer token，无 Origin/CSP（本轮砍掉）
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
- 单会话、无多租户、无速率限制
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
