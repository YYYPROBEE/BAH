# 桌面壳 choice/effects 接入 · 对抗式审查（2026-10-30）

> **审查者与被审者未分离**：本次交付与本次审查均由主线程完成（用户明令禁止派子智能体）。
> 结论按四类探针（A 造假 / B 契约 / C 安全 / D 口径）给出，每条带可复跑命令或文件行号。

- 基线：`BAH/MonoRepo` HEAD `1376ca7` + 工作树（8 改 4 新，未提交）
- 被审改动：
  - `apps/web/src/views/choice-card.js`（新）、`apps/web/src/views/effects.js`（新）
  - `apps/web/src/views/conversation.js`、`apps/web/src/main.js`、`apps/web/src/store.js`
  - `apps/web/styles/app.css`、`docs/web-frontend.md`
  - 用例：`views/choice-card.test.js`、`views/effects.test.js` 及 3 个既有用例文件
- 证据目录：`docs/evidence/2026-10-30-web-choice/`（探针脚本 + 原始日志）

## 结论

**通过（无阻断项）。** 4 项已知风险已登记并写明撤回条件（见 §5）。
没有发现"文档说做了、代码没做"或"用例空跑"的情况；两份关键声明均被独立探针坐实。

| 探针 | 结果 | 证据 |
|---|---|---|
| A 造假 | 6 个变异全部被用例捕获，还原后哈希一致 | `A-mutation.log` / `probes/A-mutation-probe.mjs` |
| B 契约 | 桌面 `store.frameKey` 与 `@bah/channels/web` 的 `frameKey` **17/17 一致** | `B-framekey.log` / `probes/B-framekey-probe.ts` |
| C 安全 | 新视图零 `fetch` / 零 `innerHTML` / 不消费 `ticketId`；XSS 探针通过并落成回归用例 | `views/choice-card.test.js`、`views/effects.test.js` |
| D 口径 | 2 处过强表述已改；1 个"看起来修好了其实没修"的场景实测复现并登记 | `C-replay.log`、本文 §4 |

门禁与用例（改动后全量重跑）：

```bash
pnpm test:web   # 29 文件 / 398 用例全过
pnpm gate       # 50/50 全绿
```

## 1. A 探针 · 用例不是空跑（变异测试）

方法：逐个破坏实现 → 跑对应用例 → 必须红 → 从内存原样还原并校验 sha256。
运行：`node docs/evidence/2026-10-30-web-choice/probes/A-mutation-probe.mjs`（脚本内路径为本机绝对路径）。

| 变异 | 结果 |
|---|---|
| M1 白名单去掉 `choice`（复原 P0） | CAUGHT（2 用例红） |
| M2 点选发送 `option.id` 而非 `label` | CAUGHT |
| M3 去掉 `choice` 视图键的 `seq`（退回 callId 合并） | CAUGHT（store + main 两组红） |
| M4 `renderFrame` 不接 `effects` | CAUGHT |
| M5 `effects` 卡塞一个"撤销"按钮（破只读） | CAUGHT |
| M6 "手动输入"改成直接发消息 | CAUGHT |

6/6 捕获、6/6 `restored=true`（哈希一致）。**结论：P0 的回归判据有效；若有人把白名单改回去，`main.test.js` 会立刻红。**

## 2. B 探针 · 契约对齐

1. **帧键**：17 个帧样例（16 种 + turn 两相位）逐帧比对，桌面 `frameKey` 与
   `packages/channels/src/web/frames.ts` 的 `frameKey` 完全一致（含 `choice/goal/todo/effects`）。
   唯一刻意偏离的是 **视图键**：`store.js:68` 给 `choice` 加了 `seq`。
   - WHY（实测）：离线 router 的 `callId` 硬编码 `call-ask`（报告 §11.2）。按 callId 合并时，第二次追问会替换第一次的节点并**留在历史位置**；真服务实测第二次追问时旧卡被移除、新开卡出现在当前流尾部。
   - 反过来，若视图键也按 callId：M3 变异证明 `store.test.js` 与 `main.test.js` 都会红。
2. **选择语义**：点选发送的是 `option.label`（`choice-card.js:75`），与 `ChoiceFrame` 的"回传只回 label"一致；帧里没有 `ticketId`，渲染器也不读 `ticketId`（grep 仅注释命中），**不存在把追问当审批放行的路径**。
3. **候选上限**：服务端 `project.ts:867` 在 `MAX_CHOICE_OPTIONS=3` 处截断；前端 `choice-card.js:19` 再 `slice(0,3)` 一次（防御，不改变输出）。
4. **`allowFreeText`**：契约收窄成字面量 `true`；"手动输入"出口无条件渲染，且是出口不是选项（零请求、只交焦点，M6 变异会被用例抓住）。
5. **effects 字段消费**：`title/amountText/name/durationMs/turn/callId` 使用；`tone`、`ticketId` 未用（与移动壳一致）。
   这不是遗漏：卡片是"钱动了没有"的只读账，不是资金审计（审计链在 `audit.jsonl`）。

## 3. C 探针 · 安全

| 检查 | 结果 | 依据 |
|---|---|---|
| XSS：模型文本进 DOM | 只走 `textContent`；注入 `<img onerror>` 后 DOM 无 `img`、文本原样 | 新增回归用例（choice/effects 各 1 条） |
| 越权：点选能否变成审批 | 不能：不消费 `ticketId`，请求体只有 `{text}` | `main.js:415` + 真服务实测 |
| 令牌 / CSRF | 走 `transport.js` 的 `api.turn`（Bearer + `x-bah-csrf`），新视图无自造 `fetch` | grep + 真服务 202 |
| 连点 / 双击 | 卡内 `inFlight` 守卫，一次点选只发一个请求 | 用例 + M6 |
| 无依赖时不假装可点 | `submit` 缺失时候选按钮 `disabled` | 用例 |
| 只读清单 | `effects` 零按钮零链接 | 用例 + M5 |

XSS 探针落成回归用例而不是一次性脚本：`views/choice-card.test.js`、`views/effects.test.js` 各一条"清单文本只作文本节点"。

## 4. D 探针 · 口径与实测复现

### 4.1 已当阶段修掉（2 条）

| # | 问题 | 处置 |
|---|---|---|
| D1 | `store.js` 注释说新卡"落在对话流末尾"——过强：新卡追加到**当时**已有节点之后，后续到达的助手消息仍排在它下面。真服务实测第二次追问时 `isLastChild=false` | 注释改为"追加到当时已有节点之后" |
| D2 | `docs/web-frontend.md` 新增的 `goal`/`todo` 行写"仅 plan profile 产生"，沿用了报告结论但本轮**未实测**；`profiles/web/patch.yml` 无 goal/plan 配置，`goal_set` 工具也没有可核实的注册点 | 改为"仅 plan 类 profile；`web` profile 当前不注册该工具 / 无 plan 事件" |

### 4.2 实测复现：快照重放会把已答的选择卡画回可点（已知风险 R1）

- 探针（characterization，非回归断言）：`probes/C-replay-probe.test.js.txt`；
  运行方式：复制到 `apps/web/src/` 后 `npx vitest run --config vitest.web.config.ts "apps/web/src/.tmp-replay-probe.test.js"`。
- 结果：点选成功 → `state=picked`；同一会话推一份**经过 JSON 序列化**的全量快照 → 节点被重建，`state=open`，候选重新可点。
- 原因：`picked` 是客户端瞬时状态，不在帧里；快照全量替换必然重建节点。移动壳 `mobile/choice-card.js` 同构同行为。
- 影响：SSE 断线重连后用户可能重复点选 → 重复发送一条普通用户消息（追问答复，不是资金操作）。
- 为何本次不修：项目口径"UI 状态只来自帧"（`store.js` 对 `streamText` 也是快照即清）。加一份 `callId:seq → label` 的内存表会引入平行状态，且需接 `sessionId` 防跨会话串味；属口径变更，应由用户拍板。
- 撤回条件（满足任一即必须修）：① 演示/评审要求"断线重连后已答卡片不可再点"；② 对外交付自研前端或第三方接入前；③ 出现重复答复引发业务误判。
- 建议修法：`mountApp` 内维护按 `callId:seq` 的记忆表（会话号变化时清空），`renderChoiceCard` 增加"已作答"入参；不放进模块级全局（防测试与会话串味）。

## 5. 已知风险 / 限制清单（无阻断项）

| # | 级别 | 项 | 处置与撤回条件 |
|---|---|---|---|
| R1 | P3 | 快照重放重置已答卡片（§4.2） | 登记；见 §4.2 撤回条件 |
| R2 | P3 | `ChoiceOption.hint` 渲染分支当前永不命中：`project.ts` 的 `choiceFrame` 只产 `{id,label}`，帧类型才声明 `hint?` | 保留（契约预留，移动壳同）；若帧类型删掉 `hint` 则同步删渲染与用例 |
| R3 | P3 | 坐席台复用 `CONVERSATION_KINDS`：操作员现在会看到 `choice`（无 deps ⇒ 候选禁用）与 `effects`（只读） | 接受：禁用不构成假可用，且操作员看得到"问过客户什么"；若坐席反馈死控件，改为只读列表或单独白名单 |
| R4 | P3 | 作答后焦点随按钮被移除落回 body（键盘/读屏用户丢失位置） | 与移动壳一致，未修；正式无障碍验收前处理 |
| R5 | 口径 | `goal`/`todo` 的发射方本轮未实测，仅按报告与帧类型登记 | 文档已加限定；plan 类 profile 实测后回填 |

## 6. 未覆盖边界（如实声明）

- 真实模型（DeepSeek）下 `prompt_ask` 不保证发生——`choice` 渲染是"必须支持"，不是"每轮都有"（报告 §5.1 同口径）。
- `password` 认证模式、真模型、`web-plan` profile 均未实测；本次只覆盖 `web` + `static` + 离线 router 一格。
- 内置浏览器面板不可见（视口 0×0）导致无法截图：样式用 computed style 断言（flex / 圆角 / 边框 / 令牌底色 / 图标映射均生效），未做像素级目检。
- 变更未提交；工作树另有 4 个他人测试文件改动，本轮未触碰。

## 7. 复跑命令

```bash
cd BAH/MonoRepo
pnpm test:web                                                    # 398 用例
pnpm gate                                                        # 50/50
node docs/evidence/2026-10-30-web-choice/probes/A-mutation-probe.mjs
npx tsx docs/evidence/2026-10-30-web-choice/probes/B-framekey-probe.ts
# C 探针：见 §4.2（需复制回 apps/web/src 下运行）
```
