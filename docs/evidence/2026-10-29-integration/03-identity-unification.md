# 03 · 身份平面统一（static 双凭证 / 26 条路由 / 17 行矩阵）

> 施工单 02 · T-03 / T-05 / T-06 / T-07 / T-08。

## 1 一套身份，两个来源

| 来源 | 模式 | 主体 | 角色 | 代码 |
|---|---|---|---|---|
| `BAH_WEB_TOKEN` | `static` | `svc:web` | `['customer']` | `web/auth/static.ts` |
| `BAH_OPERATOR_TOKEN` | `static` | `svc:operator` | `['agent']` | 同上 |
| 无 | `none` | `svc:web` | `['customer']`（**不含 agent**） | `web/auth/identity.ts` |
| 登录会话 | `password` | 目录用户 | 目录里写的角色 | `web/auth/identity.ts` |

- 两把 token 相同 ⇒ boot 期 `web-operator-token-conflict`（不静默降级）。
- 定长比较；长度不等也走一次比较（无长度侧信道）。
- 临时的 `presentedPrincipal` / `Principal = 'user' | 'operator'` / `RouteAuth = ... | 'user' | 'operator'` 全部删除：
  "客户/坐席"只由 `roles` 表达。

## 2 26 条路由与 17 行矩阵

- `ROUTES` 26 条（`web/contract.test.ts` 逐条钉住三元组）。
- 客户专属（D3）：`turn` / `interrupt` / `approval` / `verify` 仅 `customer`；坐席越权 403 `web-forbidden`。
- 坐席动作：`resume` / `message` / `claim` / `heartbeat` 仅 `agent` / `admin`；`queue` 含 `auditor`（只读）。
- `fork`：`customer` / `admin`；`trace`：D4 暂按 `ROLES`（残余风险）。
- `verify-authz-coverage`：26 条 `auth:'web'` 路由与 17 行矩阵双向覆盖，0 findings。
- 矩阵 68 格逐格断言：允许角色 ok，其余 403。

## 3 接管主体（T-08）

`HandoffSnapshot` 从 `operator?: string` 扩为：

```ts
{ at, reason?, requestedBy?, operatorId?, operatorLabel?, warnedAt?, lastSeq }
```

- `enter(reason?, requestedBy?)`：`requestedBy` 来自登录主体（不接受 body 自报）。
- `claim(operatorId, operatorLabel?)`：换人判定用 `userId`（同名不同人是两回事）；幂等。
- `say(operatorId, text, operatorLabel?)`：事件同时带 `operator`（label，给气泡）与 `operatorId`（给审计）。
- `resume(operatorId, handover?, operatorLabel?)`：交回照样落 `handoff/resumed`（带 `operatorId`）。
- 旧 `handoff.json` 的 `operator` 字符串按 label 读（只读不迁移）；新写入必须有 `operatorId`。
- body 里出现 `operator` / `requestedBy` 一律 400（`web-invalid-body`）。

## 4 测试夹具与负向用例

| 身份 | 凭证 | 用例 |
|---|---|---|
| `customerStatic` | `Bearer tok-web` | 客户页 / turn / approval / verify |
| `operatorStatic` | `Bearer tok-op` | claim / say / heartbeat / resume / queue |
| 匿名 | 无 | 401 |
| 客户打坐席 | `Bearer tok-web` | **403**（角色门，不是 401） |
| 坐席打客户 | `Bearer tok-op` | **403**（turn / interrupt / approval / verify） |
| 两 token 相同 | boot | `web-operator-token-conflict` |
| 未配坐席 token | 任意 | `/operator` 与 5 条坐席 API **404** |

`web.test.ts` 的两处历史断言按新语义改写（401 → 403；`operator: 'svc:web'` → `operatorId: 'svc:operator'` + `operator: BAH_OPERATOR_NAME`）；没有保留两套夹具。

## 5 password 模式的页面边界（T-04）

- 所有 token 入口：**无** `bah-web-token`，**有** `bah-auth-mode`，下发 CSRF cookie，`no-store`。
- 多入口用例（`index.html` + `m.html`）两页都满足；`static` 对照组两页都注入 token。
- `/operator` 在 password 模式下 `seatEnabled=false` ⇒ 404（D2 降级项，见 `docs/tenant.md`）。
