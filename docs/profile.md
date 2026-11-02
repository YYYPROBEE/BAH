# 组合系统：profile / bundle / patch

> 读者：装配插件的人与对外说明评审。
> 本文只讲"一个应用是怎么被组装起来的"；内核、会话、工具管线、模型层、主循环各自见 `docs/` 下对应文档。

---

## 1. 一句话

**应用 = 一组插件行（rows），由四层数据按 id 逐行覆盖得到；代码里没有任何 `if (profile === 'web')`。**

```text
                ┌─────────────── 四层（后层覆盖前层）───────────────┐
profile.yml ───▶│ ① bundle 行  →  ② profile patch  →  ③ home patch  →  ④ --patch overlay │──▶ 生效树
（bundles 列表） └──────────────────────────────────────────────────┘        │
                                                                             ▼
                                                  PluginManager（依赖清单 + 逐行校验）
                                                                             ▼
                                                       Context.use(...) → start() → 跑起来
```

三种语义只有两条：

| 语义 | 触发条件 | 结果 |
|---|---|---|
| **整块替换** | patch 行的 `id` 命中已有行 | 该行的 `config` **整体**换成 patch 里写的那份（**不深合并**），未写字段由插件默认值兜底 |
| **插入新行** | 行 `id` 未命中 | 追加到末尾；**必须写 `use`** 指向依赖清单里的插件实现 |

> 为什么禁止深合并：深合并会让"我到底改了哪些字段"从配置上读不出来，出事故时无法用一份 patch 解释线上状态（§8）。

---

## 2. 文件与目录

```text
bah.yml                                项目清单：profile.default + 随包 bundle 清单（门禁与 CLI 的共同输入）
packages/cli/package.json              "bah": { "profile": { "bundles": ["base"] } }   ← bundle 的发行面声明
packages/cli/bundles/<name>/index.ts   export const bundle = { name, rows: [...] }      ← bundle 数据（纯数据）
profiles/<name>/profile.yml            bundles / patch / hmr                            ← profile 清单
profiles/<name>/patch.yml              行数组（id / use / config）                      ← 层 ②
$HOME/.bah/bah.patch.yml               或 --home 指定的目录                              ← 层 ③
任意文件（--patch，可重复）                                                              ← 层 ④
```

### `bah.yml`

```yaml
profile:
  default: headless
  bundles: [base]
```

三方必须一致（门禁 `plugin-config` 逐条卡）：`bah.yml` ↔ `packages/cli/package.json` 的 `bah.profile.bundles` ↔ `packages/cli/bundles/<name>/index.ts`。

### `profiles/<name>/profile.yml`

```yaml
name: headless      # 可选；写了就必须与目录名一致
bundles: [base]     # 必填、非空；按声明顺序叠加
patch: ./patch.yml  # 可选；相对 profile 目录（层 ②）
hmr: false          # 可选，缺省 true；config-only HMR 开关
```

只有 `.gitkeep` 的 profile 目录 = **占位**：`bah --profile web` 会以 `bah-boot: profile 'web' 只有占位目录…` 退出码 1（渠道 profile 见 §8）。

### bundle 行与 patch 行（同形）

```ts
interface PluginRow {
  id: string                                // patch 的定位键，全局唯一
  use?: string                              // 插件实现 id；缺省 = id。插入新行时必填
  config?: Record<string, unknown>          // 整块替换；未写字段走插件默认值
}
```

### 本仓的 base bundle（节选；实际 17 行）

> 下表只列与业务/安全面直接相关的 12 行；`interaction:approval`、`safety:*`、
> `bank:saga-bridge` 等其余行见 `packages/cli/bundles/base/index.ts`。

| 行 id | 插件实现 | 提供 | inject |
|---|---|---|---|
| `core:session` | `provideSession` | `runtime:session` | `bah:run` |
| `core:tools` | `provideTools` | `runtime:tools` | — |
| `core:prompt` | `provideSystemPrompt` | `runtime:system-prompt` | — |
| `core:model` | mock / router / deepseek 适配器 | `llm:adapters` | — |
| `core:agent` | `AgentLoop` + 注册表 | `runtime:agents` | `bah:run`、`runtime:session`、`llm:adapters` |
| `core:persistence` | `JsonlPersistence` | `bah:session-files` | `bah:run` |
| `policy:rules` | 策略载入 / 编译 / 灰度 / 影子（`@bah/policy` + `@bah/runtime` 端口） | `runtime:policy`、`runtime:policy-meta` | `bah:run`、`runtime:session` |
| `bank:tools` | 28 个银行工具 + 治理平面 | （注册工具；默认未绑定身份） | `bah:run`、`runtime:session`、`runtime:tools` |
| `bank:saga-store` | Saga 存储 | `bah:saga-store` | — |
| `bank:saga` | Saga 协调器 | `bah:saga-clock` 等 | `bah:saga-store`、`bah:saga-audit` |
| `bank:saga-audit` | 审计链 | `bah:saga-audit` | `bah:saga-clock` |
| `demo:echo` | 示例工具 | （注册 `echo` 工具） | `runtime:tools` |

> **行序是安全边界**：`policy:rules` 必须排在 `bank:tools` 之前。`bank:tools` 在 `apply()`
> 里查找 `runtime:policy`，后置的行它看不到；`validateComposition` 会把顺序反了做成
> 启动错误 `policy-row-order`。patch 插入的新行一律**追加到末尾**，所以不要用 patch
> "新增"策略行——base 里已经有它，patch 只能按 id 整块覆盖 `config`。

`bah:run` 是**boot injection**（不是可 patch 的行）：`{ sessionId, jsonlDir?, now }` 是"这次进程启动的输入"，
写进 YAML 会让两次运行撞同一个会话，也让测试无法注入确定性时钟。

---

## 3. headless 的实际例子

`profiles/headless/patch.yml`（层 ②）：

```yaml
- id: core:model
  config:
    provider: mock
    model: mock-chat
    chunkSize: 4
    # 幕 3：给王建国转 800 元（demo 白名单，走黄级审批）
    script:
      - tool:
          id: call-1
          name: transfer_create
          args:
            amount: 800
            payee: { name: 王建国, phone: '13900002222' }
            remark: 房租
      - text: 已为你在模拟环境完成 800 元转账（黄色级别，已审批并核销）。

- id: bank:tools
  config:
    demoUserId: u-1       # 显式演示身份；不写 = 未绑定
    seed: 7
    datasetTier: demo
    # 策略外置 S3：判决走内容寻址的外置规则；回退改成 legacy 即可
    policy: { engine: bundle }

# 可选：切 active 版本 / 打开热重载。base 行不写 config 时用插件默认
# （root: policies, active: { bank.tier: bank-tier/1.0.0 }, hotReload: false）。
- id: policy:rules
  config:
    root: policies
    active: { bank.tier: bank-tier/1.0.0 }
    hotReload: false
    requireSignature: false
    shadow: { bank.tier: null }

- id: interaction:approval
  config:
    responder: headless   # 默认 none = 拒绝；headless 显式开启自动应答者
    autoDecision: allow
    autoVerify: true

- id: core:agent
  config:
    channel: headless
    loop: { model: mock:mock-chat, maxSteps: 8 }
    runtimeContext:
      user: { name: 张三, level: 金卡 }

- id: demo:echo          # 插入新行：id 不在任何 bundle 里 → 必须写 use
  use: demo:echo
  config: { prefix: '[headless] ' }
```

`pnpm bah --profile headless --dump-config`（列宽按内容自适应，下面是结构示例；长配置省略）：

```text
bah: profile headless（bundles: base；config HMR: 关）
bah: 层序 bundle → profile patch → home patch → overlay（整块替换，不深合并；未写字段走插件默认值）

id                   来源层                                        配置
-------------------  ------------------------------------------  ----------------------------------
core:session         bundle:base                                 {}
core:tools           bundle:base                                 {}
core:prompt          bundle:base                                 {}
core:model           profile-patch:profiles/headless/patch.yml   {"provider":"mock","model":"mock-chat", …}
core:agent           profile-patch:profiles/headless/patch.yml   {"loop":{…},"channel":"headless", …}
core:persistence     bundle:base                                 {"root":"sessions","fsync":true}
bank:tools           profile-patch:profiles/headless/patch.yml   {"demoUserId":"u-1","seed":7, …}
interaction:approval profile-patch:profiles/headless/patch.yml   {"responder":"headless", …}
bank:saga-store      bundle:base                                 {"dbPath":"sessions/saga.sqlite"}
bank:saga            bundle:base                                 {"maxParallelBranches":4, …}
bank:saga-audit      bundle:base                                 {"signingKeyPath":"keys/saga-ed25519.pem", …}
demo:echo            profile-patch:profiles/headless/patch.yml   {"prefix":"[headless] "}

bah: 共 12 行
```

跑一个 turn（幕 3 排练）：

```bash
pnpm bah --profile headless --prompt "给王建国转800元" --session s-tier09 --jsonl .tmp-tier09
# bah: profile headless · 会话 s-tier09
# bah: 回复 已为你在模拟环境完成 800 元转账（黄色级别，已审批并核销）。
# 29 条事件：identity/bound → tier/decided → approval/asked → ticket/issued → ticket/approved
#   → approval/decided → transfer/created → ticket/redeemed → ticket/consumed → tool/result
```

想看 08 的绿级余额链路，用同目录的 `patch-balance.yml` 做层 4 overlay（整块替换 mock 脚本，
不改变默认幕 3）：

```bash
pnpm bah --profile headless --patch profiles/headless/patch-balance.yml \
  --prompt "查一下我的余额" --session s-balance --jsonl .tmp-balance
# 23 条事件：… → tool/call → tier/decided(green/allow) → read/balance → tool/result → …
```

---

## 4. 校验与错误（fail-loud，统一 `bah-boot: ` 前缀）

配置在**建 ctx 之前**全部校验完：任何一行写错都在"第一个副作用发生之前"抛出。

| 理由码 | 触发 |
|---|---|
| `unknown-config-key` / `unknown-key` | 插件行 / profile.yml / bah.yml / patch 行出现未声明键 |
| `invalid-config` | 类型错误（非对象、非正整数、非法枚举、非字符串数组…） |
| `invalid-row` | 行缺 `id`、`use` 为空、`config` 不是对象 |
| `duplicate-row` | 同一 bundle / 同一层内 `id` 重复 |
| `row-without-plugin` | 插入新行却没写 `use` |
| `unknown-plugin` | `use` 不在依赖清单（`HOST_PLUGINS`）里 |
| `duplicate-plugin` | 同一个插件被挂两次 |
| `unknown-model` | `core:model` 的 `provider:model` 在适配器里不存在 |
| `mock-script-missing` / `mock-only-script` / `mock-only-config` | mock 脚本与 provider 不匹配 |
| `unknown-profile` / `profile-not-implemented` / `patch-missing` / `invalid-yaml` / `invalid-patch` | profile / patch 文件层 |
| `undeclared-bundle` / `unknown-bundle` / `invalid-bundle` | bundle 发现层 |
| `boot-failed` | 插件 `apply` 抛错（已装插件全部回滚后再抛） |

---

## 5. config-only HMR

- **监听**：`startConfigHmr({ profile, files, reload })`；`profile.hmr === false` 或没有可监听文件 → 返回 `undefined`（headless/sdk 显式关闭）。
- **重载**：`reload()` = 重新读层 → 重新校验 → `app.reload(layers)`。
- **只热配置**：
  - 配置变了 → 更新生效树 + 派发 `bah/config-reload`（`@mode emit`，载荷 `{ profile, changed }`）；
  - 行有增删 / `use` 指向变了 → **不动**任何东西，打印"需要重启进程"；
  - 新配置非法 → 抛错由 HMR 接住 → 打印"继续使用旧配置"，旧树保持不变。
- **不热插件代码**：`apply` 不会重跑；插件若需响应配置变化，订阅 `bah/config-reload` 后自行重读（§4 的裁剪决定：银行场景没有运行时自我修改的需求）。

---

## 6. CLI

```text
bah --profile <name> [--dump-config] [--prompt <text>]
    [--patch <file>]… [--home <dir>] [--jsonl <dir>] [--session <id>] [-h]
```

| 退出码 | 含义 |
|---|---|
| `0` | 成功（dump 完成 / turn 以 `completed` 关闭） |
| `1` | 运行期失败（配置非法、profile 未落地、agent 缺失、turn 非 completed） |
| `2` | 用法错误（未知参数、缺值、给布尔开关赋值） |

入口只做两件事：解析 argv、设置退出码（`packages/cli/src/main.ts`）；其余在 `src/cli/run.ts`（可单测）。
`pnpm bah` 通过根 `tsconfig.json` 的 `paths` 直接解析到各包 `src/index.ts`——**不需要先 build**，也就不会悄悄跑旧产物。

---

## 7. 测试对照（§6）

| ID | 用例 | 落点 |
|---|---|---|
| T-PRF-001 | 层序覆盖（home patch 盖 profile patch） | `packages/host/src/boot/profile-plugins.test.ts` |
| T-PRF-002 | 整块替换（patch 只写一个字段，其余走默认值） | 同上 |
| T-PRF-003 | 插入新行 | 同上 |
| T-PRF-004 | 未知键 → `bah-boot: ` | `packages/host/src/boot/boot.test.ts` |
| T-PRF-005 | 引用缺失插件 → `bah-boot: ` | 同上 |
| T-PRF-006 | dump-config 含来源层 | `packages/cli/src/dump-config.test.ts` + `cli/src/cli/run.test.ts` |
| T-PRF-007 | config HMR：配置重载、插件代码不重载 | `packages/host/src/boot/hmr.test.ts` |
| T-PRF-008 | headless HMR 关闭：改文件无反应 | 同上 |

补充面（无编号）：`profile.test.ts`（profile/patch 解析与 fail-loud）、`bundles*.test.ts`（bundle 发现）、
`config.test.ts`（配置原语）、`plugins.test.ts`（真实插件集进程内跑通 turn + 逐行配置校验）、
`cli/run.test.ts`（真仓库端到端：dump / turn / JSONL / 退出码）、`main.smoke.test.ts`（真实进程冒烟）。

---

## 8. 加一个新 profile（接入步骤）

1. `profiles/<name>/profile.yml`：`bundles: [base, <app>]`、`patch: ./patch.yml`、`hmr: true`；
2. `profiles/<name>/patch.yml`：只写**差异**（渠道注入、模型、语气、工具族），其余走默认值；
3. 新 bundle：`packages/cli/bundles/<app>/index.ts` 导出 `{ name, rows }`，并把 `<app>` 同时写进
   `bah.yml` 与 `packages/cli/package.json` 的 `bah.profile.bundles`；
4. 新插件实现加进 `packages/host/src/boot/plugins/index.ts` 的 `HOST_PLUGINS`（依赖清单唯一入口）；
5. `pnpm gate` 会替你核对"四处声明是否一致"，`--dump-config` 会告诉你哪一行来自哪一层。

> 规则：**渠道差异一律用 patch 表达**。代码里出现 `if (profile === 'web')` 即打回。

---

## 9. `profiles/mobile`

可运行的 profile 共**五个**：`headless` / `plan` / `web` / `web-plan` / `mobile`
（`im` / `desktop` / `sdk` 仍是占位目录，`--profile im` 会以 `profile-not-implemented` 退出码 1）。

`profiles/mobile/profile.yml` 四键与 web 逐字同形：

```yaml
name: mobile
bundles: [base]
patch: ./patch.yml
hmr: false
```

`profiles/mobile/patch.yml` 与 web 的差异**只有三处**：

| # | 行 | web | mobile | 为什么 |
|---|---|---|---|---|
| ① | `core:agent.config.channel` | `web` | `mobile` | 系统提示词按 `CHANNEL_HINTS.mobile` 裁剪（"屏幕窄，短句 + 分行要点"） |
| ② | `channel:*` 行 | `channel:web`，`port: 7331`，无 entry/entries | `channel:mobile`，`port: 7551`，`entry: index.html`、`entries: [index.html]` | 适配器（能力位）、入口 HTML、默认端口——三项渠道差异 |
| ③ | 随渠道名走的两处 | `bank:knowledge.channel: web`、`demo:echo.prefix: '[web] '` | 同名改 `mobile` | 文案与知识库归属 |

其余各行（`core:model` / `policy:rules` / `core:persistence` / `bank:tools` / `interaction:approval` /
`safety:sentry` / `bah:memory-store`）与 web **逐字一致**——门禁 `channel-capabilities` 的 I8 会比对
规范化序列化：一旦分叉就是"两套业务口径"的早期信号。

**mobile 新增的两行装配**（是"能力装配"，不是业务口径分叉；`bank:tools` 一行都没改）：

| 行 | 值 | 为什么 |
|---|---|---|
| `plan:dag`（`use: plan:dag`） | `modelTools: true`，`maxNodes: 16` | 模型看得见 `plan_propose` / `plan_execute` / `goal_set` / `todo_write`；节点工具仍由 `BANK_TOOL_NAME_SET` 锁死 |
| `bank:saga-bridge` | `enabled: false` | plan 节点本身就是 preview → create 两步，再叠一层 bridge 会展开两次（与 `profiles/web-plan` 同款理由） |

> 为什么没有给移动端单独抬日限额：生日案例三笔合计 600 元 < 默认日限 1000 元，全链黄级；
> 而给 mobile 单独写 `dailyTransferLimit` 会让 `bank:tools` 在两端出现两套取值——门禁 I8 判红，
> 也正是要防的"两套账"。演示金额因此取 300/200/100（不是 1000/300/200）。

生效树（实测）：

```text
$ BAH_KNOWLEDGE_KEY=demo-key-not-for-prod pnpm bah --profile mobile --dump-config
...
channel:mobile        profile-patch:profiles/mobile/patch.yml  {"port":7551,"host":"127.0.0.1","staticRoot":"apps/web","heartbeatMs":15000,"rateLimit":{"windowMs":60000,"maxRequests":120},"csrf":{"enabled":true},"entry":"index.html","entries":["index.html"]}
```

**入口白名单**（`entry` / `entries`，§3.8）：只有名单里的 HTML 会被注入 Bearer token
并下发 CSRF cookie；其它任何 `.html` 按普通静态资源返回（`cache-control: no-cache`、无 `set-cookie`）。
两条 fail-loud：`entries` 必须是**非空**字符串数组、禁通配符与路径分隔符、不得重复；`entry` 必须 ∈ `entries`。

> 移动壳 `m.html` 的 `entry` / `entries` 已指向 `m.html`；保留 `index.html` 是为了让 `/` 不 404。
