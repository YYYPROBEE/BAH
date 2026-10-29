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
- `pnpm test`：315 文件 / 3605 例；
- `pnpm test:snapshot`：9 文件 / 39 例；
- 负控：G6（去掉 seatEnabled 404）、G9（内联脚本）、G14（`===` 比签名）、G15（日志带 `reason:`）
  各自实跑判红并还原（见 `PROGRESS.md` §96.45）。

## 未完成：D0 真机探针

| 项 | 状态 | 阻塞 |
|---|---|---|
| 回调握手（测试号保存配置） | **未执行** | Q1：缺 AppID / AppSecret / Token 与公网域名 |
| 被动回复 | **未执行** | 同上 |
| 客服消息权限（决定 `BAH_IM_PUSH_MODE` 默认值） | **未执行** | 同上 |
| 真机四例（T-IM-001R / 002R / 009R / 012R） | **未执行** | 同上 |
| 真机审批 / H5 / 运营桥 | **未执行** | 同上 |

拿到凭据后按 `docs/wechat-setup.md` §D0 逐步执行，把结论表与截图落在本目录；
在此之前不把"真机可用"写进任何对外材料。

> 02 已在云服务器完成过一次**占位凭据**部署（模拟签名握手 + 「查余额」被动回复，见
> `PROGRESS.md` §96.44）；真实测试号的 D0 仍以本节为准。
