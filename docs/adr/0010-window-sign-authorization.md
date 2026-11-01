# ADR-0010 · 授权窗口的代签边界（`windowResponder` 与 `responder` 正交，删"无差别放行"）

- 状态：**已采纳**（2026-10-31）
- 编号说明：本编号由并行线的授权窗口占用；`docs/adr/0012-card-spend.md` 的注记引用本卡片，
  0011 预留给 AA 收口单（`0011-aa-settlement.md`）。
- 关联：ADR-0008（票据携带授权来源）、`docs/plan.md` §4、`docs/profile.md`
- 影响面：`packages/host/src/boot/plugins/approval.ts`、`packages/interaction/src/approval/`、
  `profiles/{web,web-plan,plan,headless,subscription}/patch.yml`、`packages/cli/src/cli/plan.ts`、
  `packages/eval/src/scenario/runner.ts`

---

## 1 背景

"用户不在场时按授权窗口执行"要求两件互相拉扯的事同时成立：

1. 计划到点必须能自己往前走（无人值守）；
2. 审计上必须能回答**这张票据凭什么被批**，而不是"profile 里开了个开关"。

改造前的放行面有两个口子，都在 `interaction:approval` 的配置里：

| 口子 | 位置 | 问题 |
|---|---|---|
| `autoDecision` 缺省 `allow` | `packages/host/src/boot/plugins/approval.ts` | "没配置 = 自动放行"——最容易被忽略的一条放行通道 |
| `responder: headless` 的自动应答 | 同上 | 它替**所有**审批点头，不区分"到点唤醒的窗口票据"与"人在当场发起的转账" |

于是 `headless` 一旦打开，人在场发起的转账也会被自动批准。这不是"无人值守"，是"无人审批"。

## 2 决策

> **把"代签"从"自动应答"里拆出来，做成一个独立的、缺省关闭的通道。**

`ApprovalSettings` 变成四个字段（`approval.ts:36-53`）：

| 字段 | 取值 | 缺省 | 语义 |
|---|---|---|---|
| `responder` | `none` / `headless` | **`none`** | 常规应答者。`none` = 没有应答者 = `unavailable` = **拒绝** |
| `autoDecision` | `allow` / `reject` / `cancel` | **`reject`** | 只在 `responder: headless` 时生效 |
| `autoVerify` | `boolean` | `true` | 红级是否先走强验证；`false` 时批准会被审批服务拒绝 |
| `windowResponder` | `boolean` | **`false`** | 是否注册**窗口代签**应答者（`approval.ts:105`） |

关键点：**`responder` 与 `windowResponder` 正交**。
`responder: none` + `windowResponder: true` 是"没有自动放行，但到期唤醒的窗口票据可以代签"——
这正是 plan / web-plan / subscription / headless 四个 profile 要的语义。

**"无差别放行"已删除**：全仓没有任何一格配置能表达"所有审批都批准"。

## 3 为什么不做成 `responder` 的第三个取值

直觉方案是 `responder: 'window'`。放弃它是因为**两个正交维度被一个枚举压扁**：

| 维度 | 回答的问题 |
|---|---|
| `responder` | 除窗口票据外，其他审批找谁应答 |
| `windowResponder` | 窗口票据到点时，允不允许代签 |

压成一个枚举后，"有常规应答者 + 可代签"和"无常规应答者 + 可代签"必须二选一，
而 `headless` 恰恰需要后者（演示环境里除窗口外不该有人应答）。

## 4 配置矩阵（`packages/cli/src/main.smoke.test.ts:92-98` 逐条钉死）

| profile | `responder` | `autoDecision` | `autoVerify` | `windowResponder` | 到点行为 |
|---|---|---|---|---|---|
| `web` | `none` | `reject` | `true` | **`false`** | **弹审批**，等人点 |
| `web-plan` | `none` | `reject` | `true` | `true` | 代签 |
| `plan` | `none` | `reject` | `true` | `true` | 代签 |
| `headless` | `none` | `reject` | `true` | `true` | 代签 |
| `subscription` | `none` | `reject` | `true` | `true` | 代签 |
| `desktop` / `mobile` / `im` / `sdk` | `none` | `reject` | `true` | 未覆盖 | 弹审批 |

`web` 必须是 `false`：**它一开就等于替人点头**，而 Web 的全部价值在于"人真的在场"。
`desktop` / `mobile` / `im` / `sdk` 走 `web` 的同一份 `wire.ts` 应答者
（`packages/host/src/boot/plugins/web/wire.ts:64-70`），因此同样不代签。

## 5 后果

1. **CLI 是人工渠道**：`bah plan arm` 在终端敲下等于本人点了批准
   （`packages/cli/src/cli/plan.ts:261`）。它是"人"，不是"自动"。
2. **评测夹具必须显式写 `allow`**：`packages/eval/src/scenario/runner.ts:331` 起，
   overlay 里不写 `allow` 就得不到批准——这正是想要的，夹具不该搭 profile 的便车。
3. **快照重录时审批走夹具 overlay**：`plan` / `cross-scene` / `subscription-reminder` /
   `birthday-reminder` 四个快照显式放行，不靠生产 profile 的缺省（见 `facts.md` §1）。
4. **不得宣称"headless 自动应答"**：全 profile 的 `responder` 都是 `none`。
   正确表述是"窗口代签"，不是"自动审批"。
5. **授权来源可追**：票据上的 `authorization`（ADR-0008）区分 `human` 与 `window`，
   与本文的通道边界配套——通道决定"谁可以签"，0008 决定"签了之后凭证上写什么"。

## 6 未覆盖面（显式登记）

- `desktop` / `mobile` / `im` / `sdk` 四个 profile 未单独声明 `windowResponder`，
  依赖 `DEFAULT_APPROVAL.windowResponder = false`。要支持无人值守需显式打开并在本文补一行。
- `subscription` 的定时扣款走 `plan:scheduler`，代签生效但端到端**无快照背书**
  （13 份快照 38 次 `tool/call` 里 0 次触发）；不得据此宣称"订阅扣款已自动化验证"。
