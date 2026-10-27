# 答辩排练记录（W20 · 2026-10-26）

> **数字已过期**：本文是 2026-10-26 的排练留存（历史证据，不回改）。
> 当前口径一律以 [facts.md](../facts.md) 为准：
> 主仓 **198 文件 / 2019 例**、门禁 **35/35**、快照 **6 文件 / 23 例**、覆盖率 **85.84%**。
>
> **2026-10-27 模型口径更新（A4）**：Web 主演示已默认 `provider: router`（离线）；
> 本文的 `.tmp-w20-web-router.yml` 兜底 overlay 与「正式演示建议用真实模型」不再适用，
> DeepSeek 改为可替换 provider 的证据（见 `facts.md` §5）。其余排练记录保持原样。

> 两轮。每轮记**时长、卡点、当场改了什么**。数字是墙钟实测（`date +%s%N` 夹逼），
> 同一台机器上第二次跑会快一些，所以两轮都给。
> 环境：Windows / Node `v22.22.2` / pnpm `10.34.7`；演示端口 7331。

## 0. 排练走的路线（两轮相同）

| 段 | 内容 | 对应的材料 |
|---|---|---|
| S1 | 六条命令矩阵 | `docs/drill-6-commands-2026-10-26.md` |
| S2 | plan 三幕演示（链 / 菱形失败 / dry-run） | 同上 §2.4 |
| S3 | Web 端到端：起服务 → 三层闸 → 发起转账 → 审批帧 → 批准 → 回复 | 本文 §2.3 |
| S4 | 99 秒讲结论（覆盖率双口径 + 已知限制） | `docs/drill-qa-100-2026-10-26.md` |

## 1. 第一轮（11:26–11:41，约 15 分钟）

### 1.1 时长

| 段 | 耗时 | 备注 |
|---|---|---|
| S1 六命令 | 约 52 s | 含一次重跑（命令写错，见卡点 1） |
| S2 demo-plan | 2.6 s | 一次通过 |
| S3 Web | 约 3 分 20 s | **两起两停**：第一次 boot 失败、第二次起来但模型解析失败 |
| S4 念结论 | 未计时 | 材料还没写完，只走了口述 |

### 1.2 卡点（五个，全是真卡点，不是"可能"）

| # | 卡点 | 现象 | 当场处置 |
|---|---|---|---|
| 1 | `replay.ts --verify` 单跑 | 只打印用法后退出（`--verify` 必须配 `--session`） | 矩阵第 6 条拆成两条：`--snapshots`（Merkle 抽样）+ `--session/--dir --verify` |
| 2 | `NODE_EXTRA_CA_CERTS` 未置空 | `main.smoke` 报"stderr 必须为空" | 所有命令统一加前缀；不改断言 |
| 3 | Web 起不来 | `bank:knowledge.signature: 知识库签名密钥缺失` | 演示必须带 `BAH_KNOWLEDGE_KEY=demo-key-not-for-prod`（`docs/deploy.md` 第 50 行写明） |
| 4 | **只换 `core:model` 的兜底 overlay 不生效** | 报 `provider deepseek 未注册`；实际生效行是 `core:agent.loop.model=deepseek:deepseek-chat` | overlay 必须**同时**改 `core:agent.loop.model`（两行都换才算换完） |
| 5 | 停服务后 7331 仍 LISTENING | `TaskStop` 只杀了 shell 包装，没杀子进程 | 停服务后用端口反查 PID 强杀，再确认监听数为 0 |

### 1.3 第一轮结论

**六条命令与 plan 演示一次通过；Web 段两次起停才通，且通了之后仍有一步（审批）没走完。**
按纪律，"通了但没走完"不算通过——第一轮只当"发现卡点"用，不作为交付证据。

## 2. 第二轮（11:42–11:52，约 10 分钟）

### 2.1 六条命令（修正后重跑，全绿）

| # | 命令 | 耗时 | 结果 |
|---|---|---|---|
| 1 | `pnpm test` | **13.3 s** | 194 文件 / 1951 例 |
| 2 | `pnpm test:coverage:all` | **13.4 s** | 行 84.49%（29163/34517）/ 包 14/16 |
| 3 | `pnpm gate` | **7.1 s** | 34/34（无逃生口） |
| 4 | `npx tsx scripts/demo-plan.ts` | **1.7 s** | 3 幕 / 10 条断言 |
| 5 | `npx tsx scripts/eval.ts` | **8.4 s** | 60 场景 / 49-49 / 5-5 / 6-6 |
| 6 | `npx tsx scripts/replay.ts --snapshots …` | **1.0 s** | Merkle 抽样通过 |

**S1 小计 44.9 s**（六条实际相加；首轮单跑读数偏快是缓存已热。给答辩留 60 s 余量）。

> 踩到的坑（记下来避免下次再踩）：本机 Git Bash 里 `env VAR= cmd` 不会真的给子进程设环境变量，
> 计时脚本必须用 `bash -c "VAR= cmd"`。第一版计时脚本因此报了 6 个 40 ms 的假读数。

### 2.2 plan 三幕

一次通过，10 条断言全过。录屏用的两个开关都实测过：`--pace=220` 全程 **9.3 s**（默认 1.7 s）；
`--only=diamond` 只跑第二幕、**3 条断言全过**，收尾会按实际跑过的断言条数收窄（不会把没跑的算成通过）。

### 2.3 Web 端到端（第二轮才真正走完）

启动（固定 token 便于脚本化）：

```bash
BAH_KNOWLEDGE_KEY=demo-key-not-for-prod BAH_WEB_TOKEN=w20-demo-token \
  npx tsx packages/cli/src/main.ts --profile web --serve \
  --patch .tmp-w20-web-router.yml --jsonl .tmp-w20-web --session s-w20-web
```

四步闸（实测状态码，顺序即闸顺序）：

| 步骤 | 请求 | 实测 |
|---|---|---|
| 1 | `GET /` | **200**（静态页 + 下发 `bah_csrf` cookie） |
| 2 | `POST /api/turn` 无 Bearer | **401** `web-unauthorized` |
| 3 | `POST /api/turn` 有 Bearer、无 CSRF | **403** `web-csrf-required` |
| 4 | 同上 + `Origin` + `x-bah-csrf` | **202** `{"ok":true}` |

SSE 帧（连上即拿到快照帧）：

```text
帧类型 {'turn': 1, 'audit': 14, 'dag': 1, 'message': 2, 'tool': 2, 'approval': 1}
approval 帧：¥800.00 / 王建国 / 手续费 ¥0.00 / tier=yellow / ticketId 齐备
```

批准 → 落账：

```text
POST /api/approval/ticket:8ed7f6f8-… {"decision":"allowed-once"} → 200 {"ok":true}
会话 59 事件：tool/call 2、tool/result 2、approval/asked 1、approval/decided 1、
             ticket/issued 1、ticket/redeemed 1、safety/assertion 1
回复：已为你在模拟环境完成 800 元转账，审批与核销记录见上方工具卡。
```

时长上界（按轮询间隔给保守值，不是精确值）：起服务到首页 200 **≤ 6 s**；
批准到回复落账 **≤ 4 s**。

### 2.4 第二轮结论

四段全通、审批真的走完、端口已释放（监听数 0）。**这一轮可以作为交付证据。**

## 3. 两轮对比

| 指标 | 第一轮 | 第二轮 | 变化 |
|---|---|---|---|
| 六命令 | 52 s（含重跑） | 45.1 s | 卡点 1 修掉后不再重跑 |
| Web 段 | 3 分 20 s（两起两停、未走完审批） | 约 1 分钟（一次起来、审批走完） | 卡点 3/4/5 修掉 |
| 卡点数 | 5 | 0 | — |
| 总时长 | 约 15 分钟 | 约 10 分钟 | 目标 ≤ 8 分钟（见下） |

## 4. 正式答辩的 8 分钟脚本（含每段要说什么）

| 时间 | 段 | 说什么（一句） |
|---|---|---|
| 0:00–0:40 | 开场 | 模型只选工具与措辞；钱与结论由治理平面决定。 |
| 0:40–2:10 | `pnpm test` + `pnpm gate` | 1951 例 / 34 门禁；门禁是"阻断合并"，不是提示。 |
| 2:10–3:10 | `pnpm test:coverage:all` | **行口径 84.49% / 包口径 14-16**；两个未达标包是显式放弃。 |
| 3:10–5:00 | `demo-plan.ts --pace=220` | 三幕：链路成功 / 菱形失败（blockedBy 记两条上游）/ dry-run 零假记录。 |
| 5:00–7:30 | Web 审批 | 401→403→202 三层闸；审批帧六要素；批准后核销一次。 |
| 7:30–8:00 | 收尾 | 已知限制 7 条（`docs/security-design.md` §4）+ 幻觉族 12/15 的召回缺口。 |

**超时预案**：只剩 90 s 时砍 S2 的第 2、3 幕，只演第一幕，其余用 `docs/drill-6-commands-2026-10-26.md` 的表念。

## 5. 遗留（不阻塞交付，但要知道）

1. **Web 兜底 overlay 不在仓库里**（`.tmp-w20-web-router.yml`，被 `.gitignore` 的 `.tmp-*` 覆盖）。
   它是"现场没密钥"时的救命文件，答辩前必须确认它还在；丢了按本文 §1.2 卡点 4 的两行重建。
2. ~~正式演示建议用真实模型~~ → **2026-10-27 已反转**：主演示默认离线 router（`facts.md` §5），
   DeepSeek 是可选替换项；router 只认查余额/转账，知识问答走 `pnpm demo:rag`。
3. 本机 `pnpm check`（14 步，含 build）未在两轮里计时；它是 CI 口径，答辩现场不建议跑。
