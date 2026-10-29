# 人机接管闭环演练记录（2026-10-29）

> 对应 `02-坐席工作台与交付.md` B7。全部动作走**真实 HTTP**；断言读同一进程的内存事件与
> `session.jsonl`。响应体**原文照录**，不写"成功/失败"。
>
> **合流后（2026-10-29）路径多一层租户段**：会话目录是 `<root>/<tenant>/<sessionId>/`，
> 审计/接管状态 `handoff.json` 都与 `session.jsonl` 同目录。本文历史输出**不改**；
> 复跑时以 `handoff:demo` 打印的"会话 / 审计根"两行为准。

## 1. 运行环境与命令

```bash
cd D:/项目集/微众杯银行ai智能体/BAH/MonoRepo
NODE_EXTRA_CA_CERTS= BAH_KNOWLEDGE_KEY=demo-key-not-for-prod pnpm handoff:demo
```

- 固定会话：`s-handoff-demo`；客户 token `dev-web`，坐席 token `dev-op`（显示名 `坐席小周`）。
- 演示 overlay：`channel:web.port = 0`（OS 随机端口）+ `interaction:approval.responder = headless / allow`
  （否则首轮会卡在审批弹窗上，`deriveMessages` 出现日志空洞）。
- RAG sidecar 未启动：`bank:knowledge` 按 `required:false` 降级告警，不影响接管链路。

## 2. 原始输出（本次 run）

```text
[demo] 服务：http://127.0.0.1:11984/
[demo] 会话：D:\项目集\微众杯银行ai智能体\BAH\HANDOFF-02-WT\sessions\handoff-demo-bgRpkS\s-handoff-demo
[demo] 审计根：D:\项目集\微众杯银行ai智能体\BAH\HANDOFF-02-WT\sessions\handoff-demo-bgRpkS
[demo] 客户 token：dev-web · 坐席 token：dev-op（坐席小周）
[demo] 客户 /api/turn → 202 {"ok":true}
[demo] 客户 /api/handoff → 200 {"active":true,"sessionId":"s-handoff-demo","lastSeq":66,"turns":1,"pendingTickets":1,"messages":[{"role":"user","text":"给王建国转 800 元"},{"role":"assistant","text":""},{"role":"assistant","text":""},{"role":"assistant","text":"已为你在模拟环境完成 800 元转账，审批与核销记录见上方工具卡。"}],"reason":"客户要求人工复核","at":1793205783110,"waitedMs":6,"overdue":false,"claimed":false,"turnsSinceHandoff":0,"operatorMessages":0}
[demo] 坐席发言「您好，我是人工坐席」 → 200 {"ok":true,"seq":67}
[demo] 坐席发言「正在核对收款人，请稍等」 → 200 {"ok":true,"seq":68}
[demo] 坐席发言「已核对完成，马上为您处理」 → 200 {"ok":true,"seq":69}
[demo] 客户等待中发言「我要问转账」 → 202 {"ok":true,"accepted":"queued-for-operator"}
[demo] 客户等待中发言「在吗？」 → 202 {"ok":true,"accepted":"queued-for-operator"}
[demo] 坐席交回 → 200 {"active":false,"sessionId":"s-handoff-demo","lastSeq":73,"turns":1,"pendingTickets":1,"messages":[{"role":"user","text":"给王建国转 800 元"},{"role":"assistant","text":""},{"role":"assistant","text":""},{"role":"assistant","text":"已为你在模拟环境完成 800 元转账，审批与核销记录见上方工具卡。"},{"role":"user","text":"我要问转账"},{"role":"user","text":"在吗？"}],"waitedMs":0,"overdue":false,"claimed":false,"turnsSinceHandoff":0,"operatorMessages":3,"at":1793205783110,"reason":"客户要求人工复核","operator":"坐席小周"}

[demo] ✔ 闭环断言全部通过
[demo] 审计：pnpm bah audit --dir "D:\项目集\微众杯银行ai智能体\BAH\HANDOFF-02-WT\sessions\handoff-demo-bgRpkS" --no-signature
[demo] 事件序列：handoff/requested → handoff/operator-message → handoff/operator-message → handoff/operator-message → handoff/resumed
```

## 3. 审计链复核

```bash
NODE_EXTRA_CA_CERTS= pnpm bah audit --dir sessions/handoff-demo-bgRpkS --no-signature
```

```text
bah audit · 目录 ...\sessions\handoff-demo-bgRpkS · 链 2 条 · 库 ok
✔ s-handoff-demo  9 事件  链连续  签名 0/0 skipped-disabled  投影 runtime-missing
✔ saga-4aa726d2-29d9-4acd-852b-a676921ce9da  5 事件  链连续  签名 0/0 skipped-disabled  投影 diff-zero diff=0
锚定 2026-10 ledger-missing
结论：通过
```

> `投影 runtime-missing` 是会话链的预期状态：`audit` 只读落盘目录，会话运行期内存不在。
> `签名 0/0 skipped-disabled` 是因为 `--no-signature`（演示不生成 saga 私钥）。

## 4. 脚本断言（与输出对应）

| # | 断言 | 证据 |
|---|---|---|
| 1 | 首轮产生 `approval/asked` | 会话事件含该类型；脚本 `waitFor(turn/end)` 后检查 |
| 2 | 转人工成功且摘要 `active:true` | 第二条响应 |
| 3 | 坐席 3 句都落 `handoff/operator-message` | 3 条响应 seq 67/68/69；事件计数 = 3 |
| 4 | 接管期间客户 2 条 → **202** 且 `accepted=queued-for-operator` | 第 4/5 条响应 |
| 5 | 两条 `user/message(source='handoff-waiting')` | `events()` 过滤计数 = 2 |
| 6 | 一条 `user/message(source='handoff-handover')` | 事件计数 = 1 |
| 7 | `deriveMessages()` **不含**人工 3 句、**含**交接语 | D3 / D4 的边界 |
| 8 | 交回后摘要 `operatorMessages:3`（回看口径） | 最后一条响应 |
| 9 | `session.jsonl` 同时含 `handoff/operator-message` 与 `handoff/resumed` | 文件逐行检查 |

## 5. 六张截图（人工补）

按 02 §10，截图必须由人在浏览器里做（headless 不能证明样式真的对）。
`pnpm handoff:demo --keep` 会保持服务并打印 URL 与两个 token，按以下顺序补图：

- [ ] `客户页-正常对话`：打开 `/`，对话流已回放完整历史
- [ ] `客户页-转人工横幅`：`POST /api/handoff` 后等待计时开始跳动
- [ ] `客户页-人工气泡`：`POST /api/handoff/message` 后以「坐席小周」标识的 primary 气泡
- [ ] `客户页-等待中自己发言`：接管期间在输入框发言（202，气泡正常出现）
- [ ] `坐席台-serving`：`/operator` 输入 `dev-op`，左栏显示等待时长/票据数，右侧完整对话
- [ ] `客户页-已交回提示`：`POST /api/handoff/resume` 后 3 秒内的一次性提示

> 截图未附：本次自动化只验证了**服务端行为与 HTTP 契约**，没有用 headless 截图冒充人工验收。
> 这是交付清单里唯一未闭环的人工项，已在 PROGRESS 末段登记。
