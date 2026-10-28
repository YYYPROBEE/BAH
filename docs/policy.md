# 策略外置：作者与运维手册

> 施工依据：`BAH-策略外置施工方案-2026-10-28/`（00 总纲 + 01 语言 + 02 运行时 + 03 装配 + 04 验收）。
> 本文面向"没有参与施工、但要改一条规则并安全上线"的人。
> 口径纪律：可以说"规则文件化、内容寻址、灰度/回滚、逐判决审计"；
> **不可以**说"接入 OPA/Cedar""多租户策略隔离""策略文件防篡改"（只有本地链 + 可选签名，没有外部锚定）。

---

## 1. 一句话与边界

银行三级权限的**业务升级规则**不再写死在 `tier.ts` 的分支里，而是编译自
`policies/**` 的决策表 bundle；代码只保留不可让渡的硬不变量：

| 留在代码（策略改不动） | 外置到 `policies/**` |
|---|---|
| 未绑定身份 → `no-identity` deny | 日累计超限 → 红（`daily-limit`） |
| 强验证锁定中 + 红 → `verify-locked` deny | 新收款人 → 红（`new-payee`） |
| 生效上限 `min(core 账本限额, Config 限额)` | 组合风险超阈 → 只改理由（`risky-calls`） |
| 红级强验证挑战、票据、审批 | 未来新增的业务升级/拒绝规则 |
| 绿级工具不咨询策略（TC-W04-06） | 规则顺序、默认行、拒绝码 |

默认 `policies/bank-tier/1.0.0` 与 `tier.ts` legacy 在 **960 组输入域**上：480 组已绑定逐字段等价，
480 组未绑定只验 `no-identity` 边界（bundle 不接收未绑定输入）；
`bank:tools.policy.engine: legacy` 是整体回退开关，不需要删策略文件，也不需要改代码。

**不是**通用策略平台：不做多租户隔离、不做规则可视化编辑器、不做 HTTP 管理面、
不做分布式配置中心；规则规模 >100 条时再评估 OPA/Rego。

---

## 2. 目录与文件

```text
policies/
  registry.json                    已安装清单（提交；只回答"装了哪些版本"）
  runtime-state.json               灰度/回滚状态（gitignore；不存在 = 用部署默认）
  policy-rollout/audit.jsonl       变更链（gitignore；只在 promote/rollback 后出现）
  bank-tier/1.0.0/                 生产默认
    bundle.yml                     manifest（name/version/schema/engine/parameters/...）
    rules.yml                      决策表
    corpus.yml                     验收语料（覆盖 + 边界 + 变异）
    lock.json                      内容寻址（semanticDigest + sourceDigest + 文件清单）
    CHANGELOG.md
  demo/bank-tier-demo/1.1.0/       演示候选（registry 标 `demo: true`；只验用例，不要求与 legacy 等价）
  fixtures/invalid/**              门禁负例（只给 `verify-policy-bundle` 用，不进 registry）
```

一个 bundle 目录**不可变**：就地改 `rules.yml` 一个字符，`lock.json` 的源摘要就对不上，
启动/重载直接拒绝（`policy-digest-mismatch`）。要改规则就发新版本（`1.0.1` / `1.1.0`）。

---

## 3. 写一条规则

### 3.1 `bundle.yml`

```yaml
apiVersion: bah.policy/v1
kind: bank.tier                 # v1 只认这一种
name: bank-tier                 # 必须等于目录名
version: 1.0.0                  # 必须等于目录名，semver
description: ...                # 8..200 字符
owners: [risk-platform]
schema: bank.tier.input/v1
engine: { min: 1.0.0, max: 1.x }   # 编译器版本范围
parameters:                     # 只声明名字/类型/边界，不持有值
  riskyCallThreshold: { type: integer, min: 1, max: 100 }
reasons: [declared, new-payee, daily-limit, risky-calls]  # 必须与代码词表集合相等
denyCodes: [policy-denied]      # 可选；每个都要匹配 policy-[a-z0-9-]+
rulesFile: rules.yml            # 只能是 bundle 内简单文件名（禁止 ../）
corpusFile: corpus.yml
```

### 3.2 `rules.yml`

```yaml
tables:
  - id: transfer-escalation
    appliesTo: [transfer_create]   # 必须是工具目录里的名字
    requires: [preview]            # 可选字段（preview）的表级守卫；v1 没有 has()
    hit: first                     # v1 只支持 first-match
    rows:
      - id: TR-001-over-daily-limit
        when: preview.dailyUsedCents + preview.amountCents > limits.dailyLimitCents
        raise: red
        reason: daily-limit
      - id: TR-002-new-payee
        when: preview.payee.binding == "new"
        raise: red
        reason: new-payee
      - id: TR-003-default
        when: true                 # 最后一行必须是默认行
        keep: true

  - id: risky-calls-reason
    hit: first
    rows:
      - id: RC-001-over-threshold
        when: reason == "declared" && level != "green" && state.riskyCallsInTurn >= params.riskyCallThreshold
        keep: true
        reason: risky-calls
      - id: RC-002-default
        when: true
        keep: true
```

规则：

- 一行只能有一个动作：`raise: yellow|red` + `reason`、`keep: true`（可带 `reason`）、
  `deny: policy-xxx` + `reason`；
- **没有 `lower` / `level` 字段**：任何降级动作在编译期报 `policy-lower-tier`；
- 理由只能是 manifest `reasons` 里的四个词（v1 封闭词表）；
- 表内 first-match；表按书写顺序执行，后表能读到前表演进后的 `level/reason`；
- `limits.dailyLimitCents` 是治理平面算好的**生效上限**（已取 `min(core, config)`）；
  bundle 只引用它，不持有数值；
- `params.*` 只来自部署配置（`bank:tools.riskyCallThreshold`），bundle 只声明边界；
- 金额只有整数分、没有浮点/除法/正则/函数调用/时钟/随机/环境变量；写 `1.5`、`now()`、
  `matches(...)`、`~=` 都会在编译期失败。

### 3.3 `corpus.yml`

语料不是示例，是**验收装置**。每条用例至少要有：

- 每个规则行（含默认行）至少命中一次；四种理由各一次；三级声明各一次；两种绑定各一次；
- 五类边界标签：`limit-eq`、`limit+1`、`threshold-1`、`threshold`、`threshold+1`；
- 期望字段：`level / reason / ruleIds? / deny?`。

`policy:test` 会跑覆盖 + 变异（比较符翻转、常量 ±1、动作改变、理由改变、删行），
存活变异体 = 语料杀不掉规则改动 = 红。

---

## 4. 改规则的流程（作者）

```bash
# 1. 新版本目录（不要改已安装版本）
cp -r policies/bank-tier/1.0.0 policies/bank-tier/1.0.1
# 改 bundle.yml 的 version 与 rules.yml / corpus.yml

# 2. 本地校验
pnpm policy:lint policies/bank-tier/1.0.1
pnpm policy:compile policies/bank-tier/1.0.1 --write   # 生成/更新 lock.json
pnpm policy:compile policies/bank-tier/1.0.1 --check   # 必须通过
pnpm policy:test policies/bank-tier/1.0.1              # 覆盖 + 变异必须全绿

# 3. 安装（编译 + 摘要核对 + registry 更新；不会覆盖同版本异摘要）
pnpm policy:install policies/bank-tier/1.0.1

# 4. 影子（用录制的会话日志对比旧/新，不改生效版本）
pnpm policy:shadow --from bank-tier/1.0.0 --to bank-tier/1.0.1 --sessions sessions/<dir>

# 5. 金丝雀 0.5%（50/10000）或显式会话
pnpm policy:promote --kind bank.tier --to bank-tier/1.0.1 --percent 50 --reason "canary 0.5%"

# 6. 观察 metrics（按会话/版本/理由）
curl -s -H "Authorization: Bearer <token>" http://127.0.0.1:7331/api/metrics | jq '.policy'

# 7. 全量
pnpm policy:promote --kind bank.tier --to bank-tier/1.0.1 --percent 10000 --reason "full rollout"

# 8. 回滚（清空 canary，回到 history 上一条 active）
pnpm policy:rollback --kind bank.tier --to bank-tier/1.0.0 --reason "deny spike"

# 9. 验变更链
pnpm policy:audit-verify
```

首次 `promote`（`runtime-state.json` 不存在）必须显式给 `--active <当前版本>`；
CLI 不猜当前版本。每次 promote/rollback **先写链、再原子写 state**：链写失败 = 变更失败；
state 写失败 = 链上留一条"意图"记录。

---

## 5. 部署配置

### 5.1 `policy:rules`

```yaml
- id: policy:rules
  config:
    root: policies
    active: { bank.tier: bank-tier/1.0.0 }
    statePath: policies/runtime-state.json
    hotReload: false                 # headless/CI 必须 false
    requireSignature: false          # 生产 true
    signature:
      publicKeyPath: keys/policy-1.pub.pem
      allowedKeyVersions: [1]
    limits:                          # 只做配置自检；真正上限在编译器
      maxBundleBytes: 262144
      maxTables: 32
      maxRowsPerTable: 128
      maxExprDepth: 32
    shadow:
      bank.tier: null                # 或另一个已安装版本（不能等于 active）
```

- 未知键一律拒绝（`policy-invalid-config`）；`active` 至少要有 `bank.tier`；v1 只认这一种 kind；
- `hotReload: true` 时监听 `statePath`（`fs.watchFile` 轮询）；坏 state/坏候选 = 旧版继续，
  发 `policy/reload-rejected`；
- 行序：`policy:rules` 必须排在 `bank:tools` 之前；反了启动报 `policy-row-order`。
  patch 插入的新行追加到末尾，所以不要用 patch 新增策略行——base 已有，patch 只能覆盖 `config`。

### 5.2 `bank:tools`

```yaml
- id: bank:tools
  config:
    demoUserId: u-1
    seed: 7
    datasetTier: demo
    policy: { engine: bundle }       # legacy | bundle
```

**整块替换**：patch 里覆盖 `bank:tools` 时必须重复原有键（`demoUserId/seed/datasetTier`），
否则会走插件默认值（这不是策略外置引入的语义）。

### 5.3 profile 矩阵

| profile | engine | hotReload |
|---|---|---|
| `headless` | `bundle` | `false` |
| `web` | `bundle` | `true`（演示现场切版本） |
| `web-plan` | `bundle` | `false` |
| `plan` | `bundle` | `false` |
| desktop/im/mobile/sdk | 占位，不动 | — |

回退：把对应 profile 的 `policy.engine` 改成 `legacy`，重启即可；
演练时必须验证 `tier/decided.engineSource === 'legacy'` 且判决与切前一致。

---

## 6. 审计与解释

每条 bundle 判决的 `tier/decided` 带：

| 字段 | 含义 |
|---|---|
| `engineSource` | `legacy` / `bundle` |
| `policyVersion` | identity：`bank-tier/1.0.0+sha256:<12>`；早拒路径也写当前生效版本 |
| `ruleIds` | 命中的规则行 ID（早拒为 `[]`） |
| `paramsDigest` | 部署参数稳定摘要（日限额/阈值/riskyOps/挑战渠道） |
| `evidence` | 去 PII 的完整输入 + `inputDigest`（仅实际求值时） |

链上镜像 `policy/decision`（v2 信封）：`d = sha256(canonicalJson(tier/decided.data))`。
`policy:explain` 按记录里的 `policyVersion` 找归档 bundle、用 `evidence` 复算：

```bash
pnpm policy:explain --session <sessionId> --dir sessions/<dir> --call-id <callId>
```

归档缺失 / 摘要不符 / 证据被改 → 显式失败（`policy-archive-missing` /
`input-digest-mismatch`），**不会**用新策略重算历史。

---

## 7. 故障处置

| 现象 | 根因 | 处置 |
|---|---|---|
| 启动失败 `policy-digest-mismatch` | 就地改了 bundle / lock 过期 | 发新版本并 `policy:compile --write`；不要改已安装目录 |
| 启动失败 `policy-version-missing` | 有 registry 但版本未登记 | `policy:install`；不要靠"目录在"回落 |
| 启动失败 `policy-row-order` | patch 把策略行挪到 `bank:tools` 之后 | 删掉 patch 里的策略行，靠 base 行序 |
| 启动失败 `policy-signature-invalid` | `requireSignature: true` 但缺 `bundle.sig` / 公钥不对 | 补签名与公钥；不要放宽校验 |
| 启动失败 `policy-state-invalid` | state 非法 JSON / percent 越界 / 版本不存在 | 删/修 `runtime-state.json`；可用 `policy:rollback` 重建 |
| 热重载后仍是旧版 | 候选编译失败 / 参数不兼容 | 看 stderr `policy.reloadRejected` 与 `policy/reload-rejected` 事件 |
| 判决 deny `policy-engine-error` | 输入非法 / IR 损坏 / 求值溢出 | fail-closed；查 `policy:test` 与归档摘要 |
| 判决 deny `policy-unavailable` | `engine: bundle` 但缺 `policy:rules` | 装配错误；补行或显式回退 legacy |
| 链上缺 `policy/decision` | 没装 `audit:decisions` / 写链失败 | 判决不受影响（I17）；补装配或查 stderr |
| 回放 `policy-archive-missing` | 归档 bundle 被删 | 从 registry/git 恢复；不要用新版本重算 |

---

## 8. 门禁

| 门禁 | 证明什么 |
|---|---|
| `verify-policy-bundle` | 所有 bundle 可编译；lock **整份**一致；27 个负例逐条失败在预期错误码；`requireSignature` 缺签名必拒 |
| `verify-policy-conformance` | 生产 bundle 语料/覆盖/变异全绿；`bank-tier/1.0.0` 与 legacy 960 组（480 逐字段 + 480 未绑定边界）；属性（单调/确定/总函数/输入不变）；假求值器必被语料抓住 |
| `verify-policy-hardcode` | `escalateTransferTier` 只出现在 `tier.ts`/`policy.ts`；策略包不写死资金阈值；生产规则不内联金额/级别 |
| `verify-policy-registry` | registry/state 形状与引用完整；runtime-state 不入库；rollout 链连续（存在时）；fixtures 不入 registry |

```bash
pnpm gate                 # 40 项；策略相关 4 条
npx tsx scripts/verify-policy-bundle.ts   # 单独跑
npx tsx scripts/verify-policy-conformance.ts
npx tsx scripts/verify-policy-hardcode.ts
npx tsx scripts/verify-policy-registry.ts
```

负例在 `policies/fixtures/invalid/`：降级、重复、不可达、恒假、缺默认、未知工具/参数/字段、
类型错、浮点、正则、时钟、坏理由/拒绝码、动作冲突、未用参数、引擎不兼容、坏 semver、
目录不一致、路径穿越、缺语料、摘要篡改、三张上限负例。任何一条"意外编译成功"= 门禁红。

---

## 9. 签名（生产）

- 算法 Ed25519；`bundle.sig` 覆盖 `semanticDigest` 与 `sourceDigest`；
- 公钥路径与允许的密钥版本在 `policy:rules.signature`；私钥**不进仓**（默认
  `$BAH_POLICY_KEY_DIR` 或 `~/.bah/keys`，`policy:keygen` 拒绝写进仓库）；
- 演示 profile 仍 `requireSignature: false`（链上 `policy/decision` 是 unsigned）；
- 生产签名 overlay：`profiles/web/patch-signed.example.yml`（`--patch` 显式加载）。

### 9.1 生成 / 签名 / 轮换 / 吊销

```bash
pnpm policy:keygen --dir ~/.bah/keys --version 1     # 私钥 + 公钥（私钥不进仓）
pnpm policy:sign policies/sentry-rules/1.0.0 --key ~/.bah/keys/policy-ed25519-1.key --key-version 1
```

- 签名前强制 `lock.json` 一致（过期 lock 直接拒绝，避免"旧内容 + 新文件"混合签名）；
- **轮换**：`policy:keygen --version 2` → 用新钥重签全部 bundle →
  生产配置 `allowedKeyVersions: [1, 2]` 过渡 → 再收窄到 `[2]`（旧钥即吊销）；
- **吊销**：把旧版本从 `allowedKeyVersions` 移除；旧签名立即
  `policy-signature-invalid`（`签名密钥版本 N 不在允许列表`）。
- 演练证据：`docs/evidence/2026-10-28-policy-externalization/s5-key-lifecycle.log`
  （签→验→轮换→吊销→错误密钥→unsigned 拒绝，8 步全过）。

**口径**：密钥流程已落地并可演练，但**生产尚未启用**（profile 仍 unsigned）。
在"生产 profile 开 `requireSignature` 且公钥已分发"之前，不得宣称"策略文件防篡改"；
本地链也没有外部锚定（D5③）。

---

## 10. 已知边界

- `transfer_preview` 的 `effectiveTier` 仍是 legacy 展示口径；权威判决只来自治理平面；
- `sentry.rules` 已可外置/灰度/回滚（S5），但**生产 profile 仍走 legacy**；
  切 bundle 要等 S6 影子/FP 证据（R10）；
- 管理面只有 CLI + 本地 state 文件，没有 HTTP 管理面；
- 无多租户策略隔离；`tenant` 只是预留 scope；
- 回放只保证本地链连续，没有第三方时间戳/存证；
- 旧 `tier.ts` 保留为 oracle，至少一个发布周期后再评估删除。

---

## 11. 一页速查

```bash
pnpm policy:lint <dir>                 # 语法/类型/静态分析
pnpm policy:compile <dir> --write      # 写 lock.json
pnpm policy:compile <dir> --check      # CI 口径：lock 必须存在且一致
pnpm policy:test <dir>                 # 语料 + 覆盖 + 变异
pnpm policy:versions                   # 已安装版本与状态
pnpm policy:install <dir>              # 安装 + registry
pnpm policy:shadow --from <a> --to <b> --sessions <dir>
pnpm policy:promote --kind bank.tier --to <ver> --percent <0..10000>
pnpm policy:rollback --kind bank.tier [--to <ver>]
pnpm policy:reload                     # 重写 state 触发 watcher
pnpm policy:audit-verify               # rollout 链连续性
pnpm policy:explain --session <sessionId> --dir <sessions> --call-id <callId>
pnpm bench:policy                      # compile/eval/reload 预算
```

---

## 12. `sentry.rules` 第二类 bundle（S5）

sentry 的工具参数危险模式规则（13 条内置规则）已可外置为同一交付平面里的第二类 bundle。
它与 `bank.tier` **分开编译**：执行的是正则，不是纯表达式，风险模型不同（回溯、误报、编码绕过）。

### 12.1 Bundle 形状

```yaml
apiVersion: bah.policy/v1
kind: sentry.rules
name: sentry-rules
version: 1.0.0
description: sentry 工具参数危险模式规则集
owners: [security-platform]
schema: sentry.rules.input/v1
engine: { min: 1.0.0, max: 1.x }
rules:
  - id: CMD-001
    family: destructive
    note: 递归强删文件系统命令
    pattern: '\brm\s+(-[rfRF]{1,2}\s*)+(\S+)'
    flags: i
    cases:
      match: ['rm -rf /tmp/data', 'sudo rm -RF ~']
      nonMatch: ['rm file.txt', 'remove all data']
```

规则 ID 形状 `^[A-Z]{3}-\d{3}$`；`family` 必须是六族之一；`note` 4..200 字符；
每条规则至少 **2 正例 + 2 反例**（`policy:test` 与 `verify-policy-conformance` 逐条跑）。

### 12.2 正则安全子集（编译期强制，`policy-regex-unsafe`）

| 约束 | 取值 |
|---|---|
| 正则长度 | ≤ 256 字符 |
| 字符类长度 | ≤ 128 字符 |
| 禁止 | 反向引用 `\1`、lookbehind `(?<=`/`(?<!`、`(a+)+`/`(.*)*`、`.*.*` |
| flags | 只允许 `i` / `m` / `s` |
| 规则数 | 1..64；bundle 总字节 ≤ 128 KiB |

已知放行形态：`(-[rfRF]{1,2}\s*)+` 这类"组内以字面量锚定"的有界重复（13 条内置规则之一）；
残余 ReDoS 风险由语料 + 旧内核等价 + 上线前影子兜底（R10：不通过就不切）。

### 12.3 开关与身份

```yaml
# profile patch（**当前仍是 legacy**；S6 影子通过后再切）
- id: policy:rules
  config:
    active: { bank.tier: bank-tier/1.0.0, sentry.rules: sentry-rules/1.0.0 }
- id: safety:sentry
  config:
    rules: { engine: bundle }
    trace: { sink: session }
```

- `rules.engine: legacy`（默认）= 内核 `BUILTIN_RULES`，行为逐字不变；
- `rules.engine: bundle` = 必须装配 `policy:rules` 且 `active` 含 `sentry.rules`，否则**启动失败**
  （`sentry-rules-missing`，不静默退回内核）；
- 链上 `sentry/decision.policyVersion` 改为 bundle 身份（`sentry-rules/1.0.0+sha256:<16>`）；
- 灰度/回滚与 bank.tier 同一套：`policy:promote --kind sentry.rules ...` /
  `policy:rollback --kind sentry.rules`；`policy:shadow` 仍只支持银行表（规则集用 `policy:test` 的语料等价）。

### 12.4 命令

```bash
pnpm policy:compile policies/sentry-rules/1.0.0 --write
pnpm policy:test policies/sentry-rules/1.0.0
pnpm policy:lint policies/sentry-rules/1.0.0
pnpm policy:install policies/sentry-rules/1.0.0
pnpm policy:promote --kind sentry.rules --to sentry-rules/1.0.0 --reason "首次外置"
```

门禁：`verify-policy-bundle`（编译 + 全量 lock + 语料）、`verify-policy-conformance`
（13 条规则与旧内核逐字一致 + 每条语料命中序列全等）、`verify-policy-registry`（kind/摘要/目录）。
