# apps/im-gateway

IM 长连接网关（微信公众号 ↔ 会话映射）。02 单实装：通用 `PlatformAdapter` 注册表
（生产只注册 `wechat`）、每用户一子进程的监督者、SSE → 出站投递与推送降级。

- 部署手册：[docs/wechat-setup.md](../../docs/wechat-setup.md)
- 架构与 env：[docs/im-gateway.md](../../docs/im-gateway.md)
- 启动：`pnpm im:gateway`（缺必填环境变量会以 `im-config-missing` 失败）

Mock 适配器只在 `test/` 下，`src/main.ts` 不引用它（门禁 `verify-im-gateway` G11/G12）。
