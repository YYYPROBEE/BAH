# 微信测试号接入与回调配置（IM 网关 02）

> 本文是 `apps/im-gateway` 的**部署手册**：15 分钟内能重新配好回调。
> 密钥一律从环境变量读，本文不含任何真实值（AppID/AppSecret/Token 只写占位符）。
> 机器判据：门禁 `verify-im-gateway` 的 G8（本文必须含 D0 / 回调 / 故障排查三节）。

## 0. 前置

| 项 | 要求 |
|---|---|
| 微信测试号 | 微信公众平台「测试号」页面可自助申请（无需认证） |
| 公网域名 | 必须 HTTPS 或 80 端口可访问；微信只接受**已备案/已配置**的回调 URL |
| 服务器 | 一台能跑 Node 22 的机器；网关默认监听 `0.0.0.0:8080` |
| 环境变量 | `BAH_IM_SESSION_SALT`、`BAH_WECHAT_APPID`、`BAH_WECHAT_SECRET`、`BAH_WECHAT_TOKEN` |

> 测试号的 `AppSecret` 只能换 `access_token`，**不要**写进 profile / patch / 测试夹具。
> 本地联调没有真机凭据时，网关只能跑 Mock 契约测试与假微信 API（见 §3）。

## D0. 真机探针（第一天必做）

D0 的目的只有两个：**被动回复是否可用**、**客服消息（异步推送）是否可用**。
后者决定 `BAH_IM_PUSH_MODE` 的默认值（`auto` 还是 `pull`）。

### D0.1 启动网关（本地或服务器）

```bash
# PowerShell / bash 等价；值只放进程环境，不落文件
BAH_IM_SESSION_SALT="$(openssl rand -hex 16)" \
BAH_WECHAT_APPID="<测试号 AppID>" \
BAH_WECHAT_SECRET="<测试号 AppSecret>" \
BAH_WECHAT_TOKEN="<回调 Token>" \
BAH_IM_PUSH_MODE=auto \
pnpm im:gateway
```

### D0.2 验证回调握手

在测试号页面填：

- URL：`https://<你的域名>/im/wechat/default`
- Token：与 `BAH_WECHAT_TOKEN` 一致
- 消息加解密方式：**明文模式**（本单不做 AES 安全模式）

点「提交」后观察网关日志：应出现 `im-gateway-start`，且**没有** `im-sig-invalid`。
若微信提示「配置失败」，按 §4 排查。

### D0.3 验证被动回复

个人微信扫码关注测试号，发「查余额」。期望：

1. 5 秒内收到一条回复（`auto` 模式等首个 `assistant/message` 最多 4 秒）；
2. 网关日志出现 `im-child-start` / `im-child-ready`；
3. 若 4 秒内没有结果，先收到 ack（`已收到，正在处理…（回复 0 获取最新结果）`），
   结果由客服消息补发。

### D0.4 验证客服消息

在测试号页面检查「客服消息」接口权限；或在网关日志里观察：

- 出现 `im-push-failed`（`errcode=48001/45015`）→ 客服消息不可用 → 把默认模式改成 `pull`；
- 出现 `im-push-fallback` → 已自动降级为拉取式（用户发 `0` 可取回）。

### D0.5 书面结论（模板）

| 项 | 结论 | 证据 |
|---|---|---|
| 回调握手 | （待填：通过 / 失败 + 错误码） | 测试号页面截图 + 网关日志 |
| 被动回复 | （待填） | 微信对话截图 |
| 客服消息 | （待填：可用 / `48001` / `45015`） | 网关日志 `im-push-failed` |
| 最终 `BAH_IM_PUSH_MODE` | （待填：auto / pull） | 部署环境变量 |

> **现状（2026-10-30 真机）**：测试号凭据已到位，公网入口形如 `http://<部署主机>/im/wechat/default`
> （nginx 80 → 8081）。已实测：回调握手 200、真机「查余额」被动回复成功。客服消息与审批指令
> 待补测；H5 真机因公网是 http IP 而阻塞（H5 链接只允许 `https://` 或本机 `127.0.0.1`）。

## 回调

### 1. 路由与验签形态

微信回调固定打到：

```
GET|POST /im/:platform/:accountKey
```

- 单账号：`/im/wechat/default`（`accountKey` 由 `BAH_WECHAT_ACCOUNT_KEY` 决定，缺省 `default`）；
- GET：微信后台保存配置时的 `echostr` 握手；验签通过后原样回显；
- POST：消息事件（明文 XML）；验签只看 query 的 `signature` / `timestamp` / `nonce`。

验签规则（`protocol/signature.ts`）：

```
sha1(sort([token, timestamp, nonce]).join('')) == signature
|now - timestamp| <= 600 秒
```

失败一律 **401**，响应体只有 `invalid signature`，不回显期望值。

### 2. Nginx 反代样样例（query 必须原样转发）

```nginx
location /im/wechat/default {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    # 不要改写 query：signature/timestamp/nonce 缺一不可
    proxy_pass_request_headers on;
    proxy_read_timeout 10s;
}
```

> 反代丢失 query 的典型症状是「微信后台保存配置失败」，网关日志 `im-sig-invalid`
> 且 `code=im-sig-missing`。

### 3. 本地无凭据联调

```bash
pnpm test -- apps/im-gateway            # Mock 平台 + 假微信 API（真实 HTTP）
pnpm test -- apps/im-gateway/test/platform-contract.test.ts  # 微信 + Mock 同一套契约
```

假微信 API 覆盖 `/cgi-bin/token` 与 `/cgi-bin/message/custom/send`，
`BAH_WECHAT_API_BASE` 指向它即可在无网络的情况下验证 token 单飞与推送降级。

## 故障排查

| 症状 | 可能原因 | 排查 |
|---|---|---|
| 微信后台提示「配置失败」 | Token 不一致 / query 被反代丢弃 / 网关没起 | 网关日志 `im-sig-invalid` 的 `code`：`missing`=缺参，`stale`=时钟偏差 >600s，`mismatch`=Token 不一致 |
| 用户收不到回复 | 客服消息不可用（`48001`）/ 48 小时窗口过期（`45015`） | 日志 `im-push-failed`；把 `BAH_IM_PUSH_MODE` 改成 `pull`，让用户发 `0` |
| 每条消息都要等 4 秒才回 | 模型/子进程慢 | 日志 `im-child-ready` 的 `pid/port`；检查子进程是否被闲置回收（`im-child-reap`） |
| 同一句话被回复两遍 | 去重窗口被网关重启清空 | 已知边界（§2.10）：只靠微信 3 次重试上限兜底 |
| 日志里只有 `im-child-exit restart-exhausted` | 子进程反复崩溃（配置/端口/依赖） | 检查 overlay YAML 与子进程 stderr；10 分钟内 3 次后不再重启 |
| `im-platform-unknown` | 回调 URL 的平台名/账号名写错 | 只注册 `wechat`；账号名默认 `default` |
| `im-config-missing` | 必填环境变量缺失 | 对照 `docs/im-gateway.md` §env 表 |

## 密钥纪律（复审必查）

1. AppID / AppSecret / 回调 Token **只**从环境变量读，源码、profile、测试夹具、文档一律占位符；
2. 子进程 env **不继承** `BAH_WECHAT_*` 与 `BAH_IM_*`（`supervisor.ts` 的 `SCRUBBED_ENV`）；
3. 网关日志不写 `openid` / `userId` 原文（`log.ts` 的 `FORBIDDEN_FIELDS` + 门禁 G7）；
4. `.env.example` 只放空键名与说明，不放任何演示值。
