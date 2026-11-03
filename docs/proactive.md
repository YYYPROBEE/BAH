# 主动提醒（订阅续费 + 生日）

> 对应 ADR-0016（通用通道）与 ADR-0017（AA 到期收口是同一套 `saga/tick` 时钟源）。
> 本文写清"系统自己记得、到点主动提"的规则与边界；实现细节见
> `packages/host/src/boot/plugins/{proactive,birthday}.ts`。

## 1 一条通道，两种来源

```text
saga/tick('sub-reminder' | 'birthday-reminder') 或 boot 补跑
  → 扫描（订阅清单 / 事实账本）
  → PROACTIVE_SERVICE.push（预算：静默时段 / 日上限 / 同档间隔 / 去重）
  → BANK_AUDIT.append('proactive/reminder', …)
  → WebProjector → notice 帧（不提问也看得见；刷新由快照重放）
```

- 键名是 `proactive/reminder`，不是 `sub/*`：生日、计划、安全告警都复用；
- `source` 目前有 `subscription` / `birthday`（`plan` / `safety` 是预留值）；
- **不新建第二条推送路径**：主动提醒一律落事件，由既有投影器产帧。

## 2 生日：事实格式与规则

### 2.1 事实格式（结构化，不是自由文本）

生日存在生活事实库（`fact:store`）里：

```json
{
  "person": "爱人",
  "relation": "spouse",
  "kind": "birthday",
  "date": "1990-03-08",
  "confirmed": true
}
```

- `date` 必须是合法的 `YYYY-MM-DD`；扫描只取**月/日**，年份不参与提醒；
- 闰日生日即使存成非闰年（如 `2026-02-29`）也接受；平年会按 **3 月 1 日**提醒；
- 不改 `Fact` 存储结构：`kind` / `date` 都是既有字段。

用户话术示例："记住我爱人生日 3 月 8 日"。

### 2.2 检测规则

| 规则 | 值 |
|---|---|
| 提前量 | **3 天**（含当天：0–3 天都提醒；写死在 `BIRTHDAY_AHEAD_DAYS`，不进配置） |
| 触发 | `birthday-reminder` tick job；`web` / `mobile` / `web-plan` 的 saga-bridge 为 tick-only（每 60s），启动补跑保留；批次型 `plan` 仍靠启动补跑 |
| 幂等 | `birthday:<factId>:<目标年份>`，同一生日一年只提醒一次 |
| 跨年 | 12 月 30 日提醒次年 1 月 2 日时，键里的年份是**次年** |
| 脏数据 | 缺日期 / 格式非法 / 不存在的日期 → 静默跳过，一条坏事实不影响其他人 |
| 删除 | `fact_forget` 之后账本里没有这条事实，自然不再提醒 |

提醒文案带可执行下一步：

> 「3 天后是爱人的生日（3 月 8 日）。要现在锁定 1000 元预算并安排鲜花/蛋糕吗？回复"给爱人订生日计划"即可。」

"给爱人订生日计划"会被离线路由接住，落到 `birthday/propose`（生成锁定预算 → 鲜花 → 蛋糕的计划草案）。

### 2.3 演示路径

```bash
pnpm demo:web
# 对话：「记住我爱人生日 3 月 8 日」
# 离线 router 把它翻成 fact_remember(kind=birthday, date=2000-03-08)（年份是占位值，
# 扫描只看月/日）；不接这条路由，事实库永远是空的，后面的提醒也不会出现。
# 把注入钟推到 3 月 5 日 → 页面出现上面那条提醒
# 再推一天 → 不重复；回复「给爱人订生日计划」→ 生日计划提案
```

## 3 订阅续费（摘要）

- `sub_watch(watch='remind', aheadDays)`：进入窗口逐条提醒（`source='subscription'`）；
  幂等键 `sub:<id>:<dueAt 的 YYYY-MM>`——跨月 tick 同一笔扣款不会提醒两次；
- 未标 remind 但 7 天内扣款：每天最多 1 条汇总；
- `idle`（我不用了）不提醒；静默时段当日只记 `channel='none', suppressedReason='quiet-hours'`，
  次日仍能发（不落"已发"标记）。

完整规则见 `docs/adr/0016-proactive-reminder-channel.md`。

## 4 边界（如实登记）

1. **只在应用内**：`channel` 只可能是 `in-app` / `none`；IM 主动外呼没有通道，不伪造；
2. **不持久化幂等账本**：进程重启后同一天可能重发一次（尤其 boot 补跑）；"永久不发"才是不可接受的；
3. **单会话**：一个宿主进程服务一个会话，不做"按人遍历"的多用户推送；
4. **时区固定 UTC+8**：静默时段与"几天后"的日历换算共用同一口径；
5. **生日不是日程系统**：没有"每年自动续期"的存储，事实在、规则才生效；不生成重复日程。
