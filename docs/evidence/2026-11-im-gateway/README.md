# IM 网关 02 / 03 · 证据目录

> 本目录存 02（通用网关 + 微信适配器）与 03（审批交互 + 坐席接管）的**书面证据**。
> D0 真机探针的照片/日志按 `docs/wechat-setup.md` §D0.5 的模板补齐。

## 已完成的自动化证据

| 证据 | 命令 | 结果 |
|---|---|---|
| 契约测试（微信 + Mock 同一套断言） | `pnpm test -- apps/im-gateway/test/platform-contract.test.ts` | 16 例全绿（`Fixture` 双实现逐条比对） |
| mock 端到端（入站 → turn → 出站） | `pnpm test -- apps/im-gateway/test/gateway-flow.test.ts` | 26 例全绿（假子进程 + 假微信 API） |
| 监督者（复用 / 崩溃重启 / 回收 / 上限） | `pnpm test -- apps/im-gateway/test/supervisor.test.ts` | 16 例全绿 |
| 审批文本指令（批准 / 过期 / 强验证 / 歧义 / 转人工） | `pnpm test -- apps/im-gateway/test/gateway-commands.test.ts` | T-IM-004/005/007/016 + T-H5-004 全绿 |
| H5 审批页（签名 / 过期 / 一次性 / CSP / 转义 / 红级 / 跨会话） | `pnpm test -- apps/im-gateway/test/gateway-h5.test.ts` | T-IM-015/016 + T-H5-001/002/003 全绿 |
| 运营桥（404 / 401 / 转发 / 列表脱敏） | `pnpm test -- apps/im-gateway/test/gateway-seat.test.ts` | T-IM-017 全绿 |
| 常驻会话状态（快照重建 / 审批推送 / 接管 / 坐席 / 断线重订阅） | `pnpm test -- apps/im-gateway/test/session-hub.test.ts` | 12 例全绿 |
| 协议层覆盖率 | `pnpm test:coverage` | `channels/im/**` 逐文件 100% 行/语句/函数（`link-token.ts` 分支 93.33%） |
| 网关门禁 | `pnpm exec tsx scripts/verify-im-gateway.ts` | G1–G15 全绿（G6/G9 已按 03 转强制） |

## 门户级验证（本机 mock 面）

- `pnpm gate`：51/51；
- `pnpm test`：315 文件 / 3607 例；
- `pnpm test:snapshot`：9 文件 / 39 例；
- 负控：G6（去掉 seatEnabled 404）、G9（内联脚本）、G14（`===` 比签名）、G15（日志带 `reason:`）
  各自实跑判红并还原（见 `PROGRESS.md` §96.45）。

## D0 真机探针（部分完成，2026-10-30）

部署：`ssh bah` → `/opt/bah/IMGW` @ `b8d8543`；`bah-im.service` 127.0.0.1:8081；
nginx 80 → 8081；回调 `http://124.71.73.29/im/wechat/default`（测试号已配置）。

| 项 | 结论 | 证据 |
|---|---|---|
| 回调握手 | **通过**：服务器内与公网 GET `echostr` 均 200 原样回显 | `curl` 输出（见 `PROGRESS.md` §96.46） |
| 被动回复 | **通过**：真机发「查余额」收到账户余额；公网 POST 也 200 | `wechat-passive-reply-and-children-full.jpg` |
| 客服消息（异步推送） | **待测**：尚未触发超过 4 秒的回合 | 待补 `im-push-failed` / `im-push-fallback` 日志 |
| 审批文本指令 | **待测**：转账话术需要带收款人姓名（演示夹具候选：王建国 / 张伟） | `wechat-number-intercepted-and-clarify.jpg` |
| H5 真机 | **阻塞**：公网是 `http://IP:80`，H5 链接只允许 `https://` 或本机 `127.0.0.1` | — |

真机暴露并已修复的三项：

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| D0-1 | 第二条消息起回「当前咨询人数较多」 | `BAH_IM_MAX_CHILDREN=2` 被探针会话占满 | 部署值调到 6（可调项，非硬编码） |
| D0-2 | 模型问「请选择一下」但看不到候选 | IM 投影丢弃 `choice` 帧 | `render.ts` 投影问题 + 候选（不编号） |
| D0-3 | 回 `1` 被回「当前没有待审批」，无法回答选择题 | 网关把裸 `1` 无条件当审批指令 | 无待审批时交还对话题；有票仍审批优先 |
