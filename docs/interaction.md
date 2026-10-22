# 审批服务与票据生命周期（`@bah/interaction` · 施工单 09 §2–§3）

> 本文是插件线 09 的机制说明：审批仲裁（应答者 / 超时 / 双渠道竞答）、票据账本、
> 红级挑战链与 headless 自动应答者。判定矩阵见 [bank-tools.md](bank-tools.md) §3，
> 身份绑定见 [bank-tools.md](bank-tools.md) §4。

## 1. 一句话

`approval/request` 是**唯一审批判决点**：渠道应答者注册进来，谁先回答谁赢；超时 / 无人 /
非法返回一律归一化为 `unavailable` → 拒绝；票据生命周期由本包的账本投影成 `ticket/*` 事件，
核销仍只属于 bank-core。

## 2. 模块图

```text
packages/interaction/src/approval/
├─ types.ts             渠道无关词汇表：ApprovalView / ApprovalResponder / ChallengePort / Timer
├─ events.ts            ticket/* 与 approval/* 的 durable 事件声明（模块增强 SessionEventMap）
├─ ticket-ledger.ts     票据生命周期账本（issued → approved → redeemed → consumed | blocked）
├─ service.ts           ApprovalService：应答者仲裁 / 超时 / 归一化 / 幂等（服务键 interaction:approval）
├─ headless-responder.ts  只在显式配置开启时注册的自动应答者
└─ index.ts             公开面
```

## 3. 审批时序

```text
七段管线 ③e：mintTicket → approval/asked（管线落账）
  ▼
approval/request（waterfall，注册顺序 = 外层顺序）
  ├─ bank:tools 的桥接：签五绑定票据 + 记 ticket/issued → next()
  └─ interaction:approval 的仲裁器
       ├─ 下游先说话（waterfall 纪律：next() 交还；下游已裁决则不再仲裁）
       ├─ 红级：签发挑战 → approval/challenge-issued
       ├─ 应答者 attach → 谁先 answer() 谁赢；后到者拿 already-decided + approval/duplicate
       └─ 票据 TTL 到点无人答 → approval/timeout → unavailable
  ▼
管线落 approval/decided → 仅 allowed-once 放行
  ▼
bank:tools 的桥接：approved / blocked → ticket/approved | ticket/blocked
```

**关键决定：应答者不是各注册一个 waterfall 监听器。** waterfall 是串行的——先注册的慢渠道会把
后注册的渠道堵死，做不到"任意渠道先应答者胜出"。所以审批服务独占一个监听器，渠道通过
`ApprovalResponder` 注册进仲裁器；对外契约仍是同一个 `approval/request` 挂点。

## 4. 结论枚举与归一化

| 结论 | 产生方式 | 管线行为 |
|---|---|---|
| `allowed-once` | 应答者批准（红级还必须挑战已通过） | 放行；票据 `approved` |
| `rejected` | 应答者拒绝（理由落 `approval/decided.reason`） | 拒绝；票据 `blocked` |
| `cancelled` | 用户关掉弹窗 / `service.dispose()` 取消在途 | 拒绝；票据 `blocked` |
| `unavailable` | 无应答者 / 超时 / 非法返回 / 渠道不可达 / 挑战不可用 | 拒绝；票据 `blocked` |

**任何缺省路径都只能落到 `unavailable`**（默认拒绝）：
- 没有注册应答者 → 立即 `unavailable`（不空等 TTL）；
- 应答者 `attach` 抛错 / 异步拒绝 → `unavailable`（`approval-responder-error`）；
- 应答内容不在枚举内 → `unavailable`（`approval-invalid-answer`）；
- 下游 `next()` 抛错 → `unavailable`（`approval-request-failed`）。

## 5. 票据账本

`TicketLedger` 是 bank-core 票据状态机的**审计投影**，不是第二个核销属主：

```text
issued ──approve──▶ approved ──redeem──▶ redeemed ──consume──▶ consumed
   │                    │                   │
   └──────────── block ─┴───────────────────┘──▶ blocked
```

| 动作 | 触发点 | 属主 |
|---|---|---|
| `issue` | `approval/request` 桥接（五绑定组装完成后） | bank 侧组装，账本记账 |
| `approve` / `block` | 审批结论返回后 | 审批服务结论 + 账本记账 |
| `redeem` | `tools/result` 观察到 core 状态 = `redeemed` | **bank-core**（唯一属主）；账本只 observer |
| `consume` | `tools/result` 成功 | 账本记账 |
| `block` | 失败 / 拒绝 / 超时 / 过期 | 账本记账 |

转移规则：重复的同向转移是**幂等 no-op**；反向或越级转移 `ticket-closed` / `ticket-not-approved`
（程序错了必须响）。每次真实转移落一条 `ticket/*` 事件（`ignorable: true`），可回放、可导出。

## 6. 红级挑战链（施工单 09 §6）

```text
decide() → ask + challenge('sms'|'face'|'ushield')
  ▼
仲裁器：challenges.issue()（宿主用 bank:challenge 端口 → VerifyService.issue）
  ├─ 签发失败（锁定 / 端口缺失）→ unavailable（绝不降级成黄级放行）
  ▼
应答者拿到 ChallengeView：verify() → VerifyService.submit（三连败 → 30 分钟锁定）
  ▼
应答者 answer({allowed-once})
  ▼
仲裁器强制检查 challenges.passed(challengeId)
  ├─ 未通过 → rejected + reason=challenge-required + approval/challenge-failed
  └─ 通过   → allowed-once → 票据 approved
```

强验证尝试与锁定仍按施工单 08 的事件族落账（`verify/face|sms|ushield|locked`），
所以"审批弹窗里做的验证"和"模型直接调 `verify_*` 工具"在审计上同构。

## 7. headless 自动应答者（配置）

默认 `responder: none` —— 没有应答者 = 拒绝。演示 / 回归在 profile 里**显式**开启：

```yaml
- id: interaction:approval
  config:
    responder: headless     # none（默认，拒绝）| headless（自动应答）
    autoDecision: allow     # allow | reject | cancel
    autoVerify: true        # 红级先走强验证；false 时批准会被仲裁器拒绝
    autoDelayMs: 1          # 可选，正整数；用于"慢渠道被快渠道抢先"的竞态演练
```

`interaction:approval` 行必须排在 `bank:tools` **之后**：bank 的桥接先签五绑定票据，
再把"找谁应答"交给仲裁器（waterfall 注册顺序 = 外层顺序）。

## 8. 配置键（`interaction:approval`）

| 键 | 缺省 | 校验 | 说明 |
|---|---|---|---|
| `responder` | `none` | `readEnum` | 默认拒绝；`headless` 才注册自动应答者 |
| `autoDecision` | `allow` | `readEnum` | 自动应答结论 |
| `autoVerify` | `true` | `readBoolean` | 红级是否先验证 |
| `autoDelayMs` | 无（0） | `readPositiveInteger` | 延迟应答（≥ 1ms） |

## 9. 测试对照

| ID | 用例 | 文件 |
|---|---|---|
| T-APPR-001 | 批准 → allowed-once，票据 approved | `approval/service.test.ts` + `host/.../approval.test.ts` |
| T-APPR-002 | 拒绝 + 理由 | `approval/service.test.ts` |
| T-APPR-003 | 超时 → unavailable → deny；TTL 先于审批超时 | `approval/service.test.ts` |
| T-APPR-004 | 双渠道竞答：先到者胜、后到者 already-decided、重复 decided 不重复执行 | `approval/service.test.ts` |
| （竞态三例） | first-wins / 后到者已决 / 重复 `decided` | 同上（三个独立用例） |

负控（把实现改坏 → 用例必须红）：`unavailable` 改成 `allowed-once` → T-APPR-003 红；
去掉 core 的指纹比对 → T-BANK-005 红。

## 10. 已知边界

| 项 | 现状 | 说明 |
|---|---|---|
| 渠道 UI | 未落地（施工单 13/15） | 渠道只需 `ctx.get(APPROVAL_SERVICE).attach(responder)` |
| 应答者缓存 | 服务实例按进程存活 | Web 长连接场景在 13 里按会话重建 |
| `approval/request` 下游 | 只有 bank 桥接 + 仲裁器 | 施工单 10 的 sentry 归一化可继续挂在更外层（先 `next()`，不抢判决） |
| 挑战重发 | 不重发（一次 ask 一个挑战） | 用户取消后重新发起操作会得到新票据与新挑战 |
