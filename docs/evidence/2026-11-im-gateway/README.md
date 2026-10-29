# IM 网关 02 · 证据目录

> 本目录存 02 单的**书面证据**。D0 真机探针的照片/日志按 `docs/wechat-setup.md` §D0.5 的模板补齐。

## 已完成的自动化证据

| 证据 | 命令 | 结果 |
|---|---|---|
| 契约测试（微信 + Mock 同一套断言） | `pnpm test -- apps/im-gateway/test/platform-contract.test.ts` | 16 例全绿（`Fixture` 双实现逐条比对） |
| mock 端到端（入站 → turn → 出站） | `pnpm test -- apps/im-gateway/test/gateway-flow.test.ts` | 24 例全绿（假子进程 + 假微信 API） |
| 监督者（复用 / 崩溃重启 / 回收 / 上限） | `pnpm test -- apps/im-gateway/test/supervisor.test.ts` | 14 例全绿 |
| 协议层覆盖率 | `pnpm test:coverage` | `channels/im/**` 逐文件 100% 行/语句/函数 |
| 网关门禁 | `pnpm exec tsx scripts/verify-im-gateway.ts` | G1–G13 全绿（G6/G9 在 03 单转强制） |

## 未完成：D0 真机探针

| 项 | 状态 | 阻塞 |
|---|---|---|
| 回调握手（测试号保存配置） | **未执行** | Q1：缺 AppID / AppSecret / Token 与公网域名 |
| 被动回复 | **未执行** | 同上 |
| 客服消息权限（决定 `BAH_IM_PUSH_MODE` 默认值） | **未执行** | 同上 |
| 真机四例（T-IM-001R / 002R / 009R / 012R） | **未执行** | 同上 |

拿到凭据后按 `docs/wechat-setup.md` §D0 逐步执行，把结论表与截图落在本目录；
在此之前不把"真机可用"写进任何对外材料。
