# A4 / C04 审批延迟实测（2026-10-27）

> 目的：回答 C04 的遗留问题——Web 已把会话日志设为 `fsync:false`，但审计链仍逐条
> `fsync:true` 时，会不会把"点批准后 UI 卡住"的问题抵消掉。
>
> 结论先说：**本机实测没有可感知影响**。审批结论的 HTTP 往返约 1.5 ms，
> UI 收到 `approval-closed` 的中位数在 37–42 ms 量级；audit fsync 开关造成的差异
> （约 4 ms）落在多轮抖动范围内。C04 的 `fsync:false` 不需要因为审计链而回退。

## 1. 方法

- 真实 Web 服务：`profile web`、`provider: router`、`--serve`（7331），不启动 RAG
  （`bank:knowledge` 只告警，不影响审批）。
- 通过 `GET /api/events?token=…` 订阅 SSE，记录帧到达时刻。
- `POST /api/turn` 发送「给王建国转 <金额> 元」（白名单收款人，黄级审批；两组的金额见下）。
- 收到 `approval` 帧后立即 `POST /api/approval/:ticketId`（`allowed-once`，带同源
  `Origin`）；`t0` 取提交前，`t1` 取 `approval-closed` 帧到达；同时记录 HTTP 往返。
- 单进程、单会话；基线组连续 3 轮（800 / 100 / 50 元，均为黄级），对照组连续 5 轮
  （每次 100 元）；Windows / Node v22.17.0 / pnpm 10.34.7 / 本机 SSD。
- **fsync 不是脚本开关**：临时工装只负责起服务、点批准、掐表；两档是把
  `packages/host/src/boot/plugins/audit-decisions.ts` 的 `fsync: true/false` **手工改一档、
  重启服务**后各测一组。脚本的 `--label` 只是结果标签，不改配置。

## 2. 结果

| 审计链 fsync | 样本 | UI `approval-closed` 中位数 | 范围 | HTTP 中位数 |
|---|---:|---:|---:|---:|
| `true`（HEAD `48a066a` 基线） | 3 | **41.8 ms** | 37.4–48.8 ms | 1.6 ms |
| `false`（临时对照） | 5 | **37.2 ms** | 35.7–46.4 ms | 1.5 ms |

差约 4.6 ms（中位数），小于同一配置内的轮次抖动（最大 11 ms）。样本量小，只能判
"没有数量级影响"，不能当性能基准。

## 3. 边界与说明

- **两组都是测量时的 `audit:decisions`（尚未含 B4 的 `tool/result` 摘要）**：
  跑完后核对两组 `audit.jsonl`，均只有 `tool/call` 与 `approval/decided`，没有
  `tool/result`。因此这是**单变量对照**（只差 fsync），不是拿 B4 的新代码比旧代码。
- 测量之后 B4 才在工作树加入 `tool/result` 摘要与签名分支（并把 fsync 设为 false）；
  B4 的额外 append 未在本页计时，D1 若要覆盖它应重跑。
- 当前工作树的 `audit:decisions` 已使用 `fsync:false`；若后续改回 `true`，
  本页数字可作为回退前的参照。
- 本页只回答"点批准 → UI 收尾帧"；长会话、并发审批、10+ SSE 客户端属于 D1 的
  性能基线，不在 A4 范围。
- 测量工装是临时的（`.tmp-a4/measure-approval.mjs`，被 `.gitignore` 的 `.tmp-*` 挡住，未入库）。
  复现按 §1 手工做：起服务 → 订 SSE → `POST /api/turn` → 收到 `approval` 帧后 `POST
  /api/approval/:ticketId`（带同源 `Origin`）→ 掐到 `approval-closed` 帧；两组之间手工改
  `audit-decisions.ts` 的 `fsync`。工装里 `amounts` 是常量（基线组当时是 800/100/50，
  对照组改成 100×5），金额不参与结论，只保证都是黄级白名单转账。

## 4. 对 B4 / D1 的输入

- B4：审计链逐条 fsync 不是审批弹窗卡顿的主因（本页实测）。B4 新增的 `tool/result`
  摘要 append **不在本页测量范围**（§3），需要 D1 重跑才能给结论。
- D1：若要给出 p50/p95 性能基线，应把审批、SSE 投递、审计 append 分开计时；
  本页只是单机 3 轮 + 5 轮的粗测，不做基准宣称。
