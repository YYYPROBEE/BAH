# 组合系统：profile / bundle / patch（施工单 06）

> 读者：插件线（07–15）与答辩评审。
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

> 为什么禁止深合并：深合并会让"我到底改了哪些字段"从配置上读不出来，出事故时无法用一份 patch 解释线上状态（施工单 06 §8）。

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

只有 `.gitkeep` 的 profile 目录 = **占位**：`bah --profile web` 会以 `bah-boot: profile 'web' 只有占位目录…` 退出码 1（渠道 profile 属插件线 13–15）。

### bundle 行与 patch 行（同形）

```ts
interface PluginRow {
  id: string                                // patch 的定位键，全局唯一
  use?: string                              // 插件实现 id；缺省 = id。插入新行时必填
  config?: Record<string, unknown>          // 整块替换；未写字段走插件默认值
}
```

### 本仓的 base bundle（七行）

| 行 id | 插件实现 | 提供 | inject |
|---|---|---|---|
| `core:session` | `provideSession` | `runtime:session` | `bah:run` |
| `core:tools` | `provideTools` | `runtime:tools` | — |
| `core:prompt` | `provideSystemPrompt` | `runtime:system-prompt` | — |
| `core:model` | mock / deepseek 适配器 | `llm:adapters` | — |
| `core:agent` | `AgentLoop` + 注册表 | `runtime:agents` | `bah:run`、`runtime:session`、`llm:adapters` |
| `core:persistence` | `JsonlPersistence` | `bah:session-files` | `bah:run` |
| `demo:echo` | 示例工具 | （注册 `echo` 工具） | `runtime:tools` |

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
    script:
      - tool: { id: call-1, name: echo, args: { text: 你好，我是 headless 验收用的回显工具 } }
      - text: 已为你在模拟环境完成查询。

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

`pnpm bah --profile headless --dump-config`（列宽按内容自适应，下面是结构示例）：

```text
bah: profile headless（bundles: base；config HMR: 关）
bah: 层序 bundle → profile patch → home patch → overlay（整块替换，不深合并；未写字段走插件默认值）

id                来源层                                        配置
----------------  ------------------------------------------  ----------------------------------
core:session      bundle:base                                 {}
core:tools        bundle:base                                 {}
core:prompt       bundle:base                                 {}
core:model        profile-patch:profiles/headless/patch.yml   {"provider":"mock","model":"mock-chat", …}
core:agent        profile-patch:profiles/headless/patch.yml   {"loop":{…},"channel":"headless", …}
core:persistence  bundle:base                                 {"root":"sessions","fsync":true}
demo:echo         profile-patch:profiles/headless/patch.yml   {"prefix":"[headless] "}

bah: 共 7 行
```

跑一个 turn：

```bash
pnpm bah --profile headless --prompt 你好 --session s-demo
# bah: profile headless · 会话 s-demo
# bah: 回复 已为你在模拟环境完成查询。
# bah: 已落盘 sessions/s-demo/session.jsonl（20 条事件）
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
- **不热插件代码**：`apply` 不会重跑；插件若需响应配置变化，订阅 `bah/config-reload` 后自行重读（施工单 06 §4 的裁剪决定：银行场景没有运行时自我修改的需求）。

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

## 7. 测试对照（施工单 06 §6）

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

## 8. 加一个新 profile（插件线 13–15 的接入步骤）

1. `profiles/<name>/profile.yml`：`bundles: [base, <app>]`、`patch: ./patch.yml`、`hmr: true`；
2. `profiles/<name>/patch.yml`：只写**差异**（渠道注入、模型、语气、工具族），其余走默认值；
3. 新 bundle：`packages/cli/bundles/<app>/index.ts` 导出 `{ name, rows }`，并把 `<app>` 同时写进
   `bah.yml` 与 `packages/cli/package.json` 的 `bah.profile.bundles`；
4. 新插件实现加进 `packages/host/src/boot/plugins/index.ts` 的 `HOST_PLUGINS`（依赖清单唯一入口）；
5. `pnpm gate` 会替你核对"四处声明是否一致"，`--dump-config` 会告诉你哪一行来自哪一层。

> 规则：**渠道差异一律用 patch 表达**。代码里出现 `if (profile === 'web')` 即打回。
