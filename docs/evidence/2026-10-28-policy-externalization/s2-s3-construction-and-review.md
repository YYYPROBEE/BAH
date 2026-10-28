# 策略外置 · S2/S3 施工与对抗式复审

- 施工范围：`02-运行时判决平面.md`（PE-20 … PE-39）
- 施工时间：2026-10-28
- 输入 HEAD：`61d7c83`（S1 已落库）
- 交付 checkpoint：`1ea501d`（S2）；S3 为本批提交
- 上游方案：`BAH-策略外置施工方案-2026-10-28/00-总纲与决策.md`、`02-运行时判决平面.md`

---

## 1. 交付物

| 类别 | 内容 |
|---|---|
| 银行接入 | `tier.ts` 可选 `escalation`；`policy.ts` 构造 `BankTierInput` / `paramsDigest` / `evidence`；`governance.ts` 九步顺序、策略异常/缺服务 fail-closed、deny 覆盖、审计失败不改判 |
| 宿主 | `policy:rules`（registry/state 载入、编译、参数绑定、灰度、影子、热重载、活描述符）；`bank:tools.policy.engine` |
| 审计 | `tier/decided` 增 `policyVersion/ruleIds/paramsDigest/engineSource/evidence`；`policy/decision` v2 链行 + `SIGNED_TYPES` |
| 管理面 | `policy:versions/install/promote/rollback/reload/audit-verify/shadow/explain`；`bench:policy` |
| 观测 | `/api/metrics.policy`（版本/判决/理由/引擎错误/legacy/影子/重载） |
| 数据 | `policies/registry.json`、`policies/demo/bank-tier-demo/1.0.0` |
| 接线 | base 行序 `policy:rules → bank:tools`；headless/web/web-plan/plan 切 `engine: bundle`（web `hotReload: true`） |
| 快照 | 6 个场景重录（新增 `policy/bundle-loaded`、`tier/decided` 新字段、seq 位移） |

---

## 2. 判据实测

| 判据 | 结果 |
|---|---|
| `pnpm typecheck` | ✔ 三项全绿 |
| `npx vitest run` | ✔ **219 文件 / 2401 例** |
| `pnpm test:snapshot` | ✔ 7 文件 / 28 例 |
| `pnpm gate` | ✔ **36/36**（S4 的 4 条新门禁尚未加入） |
| `pnpm policy:compile --check` | ✔ digest 一致 |
| `pnpm policy:lint` | ✔ 2 表 / 5 规则 |
| `pnpm policy:test` | ✔ 20 例、5/5 规则、4/4 理由、16/16 变异 killed |
| `pnpm bench:policy` | ✔ compile avg 1.703 ms、eval p99 3.700 µs、reload 1.705 ms（启动路径跳过语料解析） |
| 管理面冒烟 | ✔ install ×2 → promote 5% → rollback → audit-verify（链 2 条连续） |
| explain 闭环 | ✔ 真实 host 会话：bundle 判决 → evidence → policy/decision → explain 复现，链 verified |

---

## 3. A 角度：验收与契约

| # | 结论 | 证据 |
|---|---|---|
| A-01 | 通过 | `engine: bundle` 时治理平面不再调用 `escalateTransferTier`；策略只提供 escalation |
| A-02 | 通过 | 载入即校验：坏 YAML / lock / 签名 / registry / state / 参数均在启动期失败，带稳定错误码 |
| A-03 | 通过 | 每条 bundle 判决带 `policyVersion + ruleIds + paramsDigest + engineSource + evidence`；早拒路径写当前版本 + `[]` |
| A-04 | 通过 | 链上 `policy/decision` 的 `d = sha256(canonicalJson(tier/decided.data))`；v2 信封 `subject/decision/policyVersion` |
| A-05 | 通过 | `policy:explain` 按记录 digest 找归档复算；归档缺失/摘要不符显式失败 |
| A-06 | 通过 | 灰度：显式名单 + 万分比 + epoch 分桶；`policy:promote` 先写链再原子写 state |
| A-07 | 通过 | 回滚：`policy:rollback` 清 canary / 回 history 上一条 active；`engine: legacy` 是最终 kill switch |
| A-08 | 通过 | 等价：`bank-tier/1.0.0` 与 legacy 在 960 组输入域逐字段相等（480 已绑定 + 480 未绑定边界） |
| A-09 | 通过（有边界） | metrics 从事件现算，不新造计数器；`byVersion` 是判决时版本 |
| A-10 | 通过（有边界） | 4 条 S4 门禁、`policy-externalized` 快照、`docs/policy.md` 与证据包仍未交付 |

---

## 4. B 角度：对抗与回归

| # | 结论 | 证据 |
|---|---|---|
| B-01 | 通过 | 降级/重复/不可达/缺默认/未知工具/未知参数/浮点/正则/时钟/随机：S1 编译期拒绝（24 条负控） |
| B-02 | 通过 | 篡改 bundle：lock/摘要不符 → 启动失败；registry 有清单但版本未登记 → `policy-version-missing`（不静默用目录） |
| B-03 | 通过 | 引擎抛错 / 缺 input / 返回非法 level / 缺 ruleIds / 空版本 / 未知理由 → 全部 deny，无 allow |
| B-04 | 通过 | 策略 allow 不能把红/黄降级；策略 deny 覆盖 allow；绿级读工具不咨询策略 |
| B-05 | 通过 | 锁定中 + 红：策略 allow 仍 deny `verify-locked`；`no-identity` 不进策略 |
| B-06 | 通过 | 坏 state / canary percent 越界 / sessions 非数组 / active 空串 / shadow 自指 → 启动/重载失败 |
| B-07 | 通过 | 重载失败保持旧版（`policy/reload-rejected`）；版本未变不产生 `bundle-switched` |
| B-08 | 通过 | explain 证据被改 → `input-digest-mismatch`；链缺失默认提示、`--require-chain` 失败；归档缺失退出码 1 |
| B-09 | 通过 | 审计 sink 抛错：判决不变（I17），只 stderr 告警 |
| B-10 | 通过 | 快照差异逐条审：只新增计划内事件/字段；无 evaluate 路径漂移（legacy 与 bundle 判决逐字段一致） |
| B-11 | 通过 | 热重载参数绑定：候选 bundle 与部署参数不兼容 → `reload-rejected`，描述符/判决仍是旧版（P2-8 修复后新增用例） |
| B-12 | 通过 | 影子候选求值失败只落 `shadow-error` 差异，生效判决不变（P1-4 修复） |

---

## 5. 复审发现与处置

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| P1-1 | P1 | `fs.cpSync(..., { recursive: true })` 在本机中文路径下让 Node 进程**无输出退出（127）**，测试 worker 直接死 | 测试夹具与 `policy:install` 改为 `readdirSync + copyFileSync` 手写递归复制；登记为环境缺陷 |
| P1-2 | P1 | 审计 sink 抛错会抛穿治理平面，把已做出的判决变成工具错误 | `appendTierDecided` try/catch，只告警；补 I17 用例 |
| P1-3 | P1 | 引擎返回 `level` 但缺 `ruleIds/policyVersion` 时被静默接受，审计会出现"有升级无规则" | 四个字段作为一组校验；非法即 deny `policy-engine-error` |
| P2-1 | P2 | 热重载后 `activePolicyVersion` 是装配期字符串，早拒路径会一直写旧版本 | 描述符改为活引用 getter；治理平面接受 `() => string`；补活引用用例 |
| P2-2 | P2 | registry 存在但版本未登记时，`compileAt` 回落到目录推断，等于"有目录就能用" | 有 registry 时强制 `policy-version-missing`；补负例 |
| P2-3 | P2 | `runtime-state` 只校验 apiVersion，percent/sessions/active 形状不查 | 增加形状校验；补越界/非数组/空串负例 |
| P2-4 | P2 | `active: {}` 被当成"用默认"，与"显式空映射是配置错误"冲突 | 显式空映射 → `invalid-config` |
| P2-5 | P2 | `policy/bundle-switched` 的 `from/to` 写 handle，02 §4.3 要求 identity | 改为 `policyVersion` identity；更新用例 |
| P2-6 | P2 | 重载每次都发 `bundle-switched`，state 无关变化也会计数 | 比较描述符身份键；无变化只换引用 |
| P2-7 | P2 | 编译 1.0.0 平均 6.5 ms，超 5 ms 预算；语料解析占大头 | `CompileOptions.withCorpus`（默认 true）；启动路径跳过语料，编译降到 1.7 ms；语料仍由 `policy:test`/门禁覆盖 |
| P2-8 | P2 | 热重载换到"参数声明不同"的 bundle 时，启动期的部署参数绑定不会重新校验；切换成功后首条判决才 fail-closed | 新增 `runtime:policy-param-check` 服务：`bank:tools` 提供检查函数，`policy:rules` 在原子替换**前**调用；不兼容 → `policy/reload-rejected(policy-param-mismatch)`，旧版继续。另在 `loadSnapshot` 强制 active/canary/shadow 参数名集合一致 |
| P1-4 | P1 | 影子候选求值抛错会抛穿 `engineOf`，把**生效**判决变成 `policy-engine-error`（违反"影子不生效"） | 影子求值单独 try/catch；失败只发 `policy/shadow-diff(changed=['shadow-error'])` + stderr，照常返回 active 判决 |
| P2-9 | P2 | 管理面 CLI 未接 `public-key/requireSignature`：签名 bundle 的 `policy:install/promote/explain` 会因缺公钥 fail-closed（宿主运行期已支持） | 登记为 S4 运维流程（密钥分发/轮换文档）的一部分；本批不伪造签名测试，也不放宽校验 |
| P3-1 | P3 | `policy:explain` 的规则行号靠扫描 `rules.yml`（IR 不保留行号），列号不精确 | 已在源码注释登记；人类输出只要求行号 |
| P3-2 | P3 | 审计 sink 失败只 stderr，没有 `policy/audit-failed` 事件 | 事件出口与失败出口是同一个 session；强发只会二次失败。I17 已满足，指标侧暂不计数（登记） |

---

## 6. 口径与未完成

- **可以说的**：策略已外置到 `policies/**`；默认 bundle 与 legacy 穷举等价；判决带版本/规则/证据；链上可复现；灰度/回滚/热重载可执行；`engine: legacy` 可整体回退。
- **不能说的**：4 条 S4 门禁（40/40）、`policy-externalized` 快照、`docs/policy.md`、CI 覆盖率台账更新、Ed25519 生产密钥流程——这些属于 S4/S6，不在本批。
- **已知红**：`pnpm test:coverage` 的逐文件 100% 在本机仍有缺口（`host/boot` 的既有文件 + 本批新增防御分支）；全仓口径 87.56% 达标。覆盖率台账与逐文件清债留到 S4/CI 跑批，不在本批写本机数。
