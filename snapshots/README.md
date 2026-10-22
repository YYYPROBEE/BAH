# 快照回放（snapshots/）

> 规格：施工单 12 §3–§4 · 操作手册与夹具 API 见 [docs/testing.md](../docs/testing.md) §9
> 一句话：**一条命令、无密钥、无网络**地验证"模型看到的与用户看到的没变"。

## 为什么有这一层

底座跑完一个 turn 会落一串会话事件（`turn/start` … `assistant/message` … `turn/end`）。
插件线与后续迭代最怕的不是编译错误，而是**悄悄改变了模型看到的东西**（提示词段顺序、工具 schema、
上下文 reconcile、参数默认值……）。这类回归单测很难覆盖，快照回放就是为它准备的：

- 录制时把 **provider 的流式分片** 与会话事件一起存进仓库；
- 回放时用录制下来的分片重建同一个 turn，再逐条**整行**比对事件流。

任何一步偏了，`pnpm test:snapshot` 立刻红，并打印第一处差异。

## 目录结构

```text
snapshots/
├─ headless-basic/
│  ├─ session.jsonl      录制的事件流（= 运行时会话日志格式，JsonlPersistence 能原样读回）
│  ├─ llm.jsonl          每次 provider 调用的请求标识 + 响应分片（一行一次调用）
│  ├─ scenario.json      场景输入：prompts / 会话 ID / 时钟 / 种子 / 生效行 / 模型规格
│  ├─ scenario.ts        场景本体（录制与回放共用：怎么装应用、送哪几句话）
│  └─ snapshot.test.ts   T-AUD-005（record→replay 全等）+ T-AUD-006（两次回放全等）
├─ web-channel/
│  ├─ session.jsonl / llm.jsonl / scenario.json
│  ├─ overlay.yml        层 4：真起 Web 渠道（端口 0）
│  └─ scenario.ts / snapshot.test.ts
├─ sandbox-compute/
│  ├─ session.jsonl / llm.jsonl / scenario.json
│  ├─ overlay.yml        层 4：三面 mock 脚本 + stress 档
│  └─ scenario.ts / snapshot.test.ts
└─ fixtures.test.ts      快照通道冒烟（命名解析 + 代次选择）
```

> `sandbox-compute` 背书此前无场景声明的 `packages/safety/src/sandbox-runtime/`、`packages/bank/src/forge/`、`packages/bank/src/verify/`。
> 它用独立的 `RunContext.sandboxNow` 计数钟，`sandbox/done.elapsedMs` 恒为 5；会话事件 `at` 仍来自 `fixedClock`。

## 两条命令

```powershell
# 回放（默认；CI 用这一条）——只读：不联网、不读密钥、不写文件
pnpm test:snapshot

# 录制（人工；改了模型可见/用户可见的东西之后）——脚本内部注入 BAH_SNAPSHOT_RECORD=1
pnpm snapshot:record
```

录制会在同一条用例里**立刻回放比对**：新录的快照如果不自洽，当场就红。

> 门禁 `snapshot-fresh` 会拦「改了 `packages/{runtime,llm}/src` 却没改 `snapshots/`」的提交。
> 纯重构（无行为变化）用 `BAH_ALLOW_NO_SNAPSHOT=1 pnpm gate` 放行，或在提交信息里写 `[no-snapshot]`。

## 回放为什么不需要密钥与 profile

`scenario.json` 里存了录制时**实际生效的插件行**（`id / use / config`）与模型规格（含能力位）。
回放直接用这些行重建应用，**不读** `profiles/`、不读 `bah.yml`、不读开发机上的 `~/.bah`：

- 仓库里的 profile 改了 → 快照仍然可以回放（它是**历史事实**），但 `record` 会失败或产生差异 → 提醒你重录；
- 想验证"当前代码 + 当前 profile"是否与历史一致，靠的就是"回放红 → 重录 → 人工确认差异"。

## 确定性四件套（缺一条就会偶发失败）

| 纪律 | 落点 |
|---|---|
| 时钟 | `scenario.json` 的 `clock.start/step` → `fixedClock` 注入 `boot({ run: { now } })` |
| 随机 | `scenario.json` 的 `randomSeed`（`seededRandom`，与 bank-forge 同源接口） |
| 环境 | home patch 指向一个不存在的临时目录；会话目录是临时目录（回放不写仓库） |
| 网络 | provider 是 `ReplayAdapter`（只吐录制分片）；构造期不读密钥 |

## 负控（证明护栏真的会响）

`snapshot.test.ts` 里有一条用例：把 `session.jsonl` 复制到临时目录、篡改一条 `assistant/message`，
断言比对**必须**不等。护栏自己不被验证，等于没有护栏。

## 加一个新快照用例

1. 复制 `snapshots/headless-basic/` 成 `snapshots/<case>/`（改 `CASE.name` 与 prompts）；
   要换 mock 脚本（`core:model.script`）时**不要改** `profiles/headless/patch.yml`——照
   `web-channel` / `sandbox-compute` 在本目录加 `overlay.yml`，录制时作为层 4 传入；
2. `scenario.ts` 里换成你要的 profile / 输入（装配仍走 `@bah/host` 的 `boot`，不要绕过它）；
3. `pnpm snapshot:record` 录制；
4. `pnpm test:snapshot` 跑一遍只读回放，确认绿。

> 纪律：**CI 永远只读**。`recordSnapshot` 只在 `BAH_SNAPSHOT_RECORD=1` 时被调用；
> 回放路径里没有任何写文件的代码（除临时目录，且用后即删）。
