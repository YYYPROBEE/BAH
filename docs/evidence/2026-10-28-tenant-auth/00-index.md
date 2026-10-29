# 租户与鉴权 · 四单总索引（2026-10-28 方案）

> 四单：01 租户模型 → 02 鉴权平面 → 03 授权平面 → 04 隔离验证与交付。
> 结论口径：`DONE` = 判据全绿 + 证据在；`DONE-WITH-DEVIATION` = 绿了但偏离文档，偏差表有记录。

## 1 完成状态

| 单 | 结论 | 提交 | 证据 |
|---|---|---|---|
| 01 租户模型与全平面贯通 | **DONE-WITH-DEVIATION** | `29625d9`（交付）+ `dc26952`（复审） | `01-t1.md` / `01-review.md` |
| 02 鉴权平面（AuthN） | **DONE-WITH-DEVIATION** | `2285796` | `02-t2.md` / `02-review.md` |
| 03 授权平面（AuthZ） | **DONE-WITH-DEVIATION** | `be9426b` | `03-t3.md` / `03-review.md` |
| 04 隔离验证与交付 | **DONE-WITH-DEVIATION** | 本提交（`git log -1`） | `04-t4.md` / `04-review.md` |

分支：`tenant-01-core` → `tenant-02-authn` → `tenant-03-authz` → `tenant-04-delivery`（严格串行）。

## 2 本目录的文件

| 文件 | 内容 |
|---|---|
| `00-index.md` | 本文件（总账） |
| `01-t1.md` / `01-review.md` | 01 的命令与真实输出 / 复审（AR-01…AR-09） |
| `02-t2.md` / `02-review.md` | 02 的证据 / 复审（AR-15…AR-28） |
| `03-t3.md` / `03-review.md` | 03 的证据 / 复审（AR-29…AR-44） |
| `04-t4.md` / `04-review.md` | 04 的证据 / 复审（AR-45…AR-58） |
| `matrix-demo-acme.txt` | `tenant-matrix --keep` 的 8/8 原始输出 |
| `coverage-auth.txt` | `web/auth/*` / `web/authz/*` 的逐文件行覆盖（≥90% 判据） |
| `gates.txt` | 最终 `pnpm gate` 全量输出（44/44） |

## 3 总账：哪些"多租户"是真的，哪些是部署约束，哪些明确不做

### 3.1 真的（有可复跑证据）

- **部署级多租户**：同一套代码、同一台机器并存 demo / acme 两个进程；
  `tenant-matrix` 8/8 证明凭证、票据、租户头不跨进程，目录与记忆库字节不交叉，
  metrics 的 `tenant` 正确。
- **落盘隔离**：`<root>/<tenant>/{session.jsonl,audit.jsonl,memory.db,auth/sessions.jsonl}`；
  `fileOf` 倒数第三段 = 租户（门禁判据 2/3）。
- **认证/授权**：会话 cookie 只在所属租户进程有效；角色矩阵（11 条 web 路由）只有
  `authorize()` 一处判定；审批操作者 `approval/actor` 入链（"人批必有主"）。
- **启动输入**：`--tenant ../demo` 在 CLI 层退出 2（A6）；运行期请求头/查询参数不改变租户。

### 3.2 部署约束（文档写清，不是"已实现"）

- `saga.sqlite` **不按租户分库**：两个租户必须用不同 `--jsonl`/工作目录；同目录会 `warn`
  （`saga.tenant` 标记），但不会阻断。
- 管理面必须独立端口且只绑 `127.0.0.1`：同机反代会让"只接受回环"退化为只剩 token；
  boot 期有 `warn`，但不检测反代本身。
- `BAH_KNOWLEDGE_TOKEN_<TENANT>` 非 demo 必须配置；共享回退只服务 CI/本地。
- HTTPS 部署要把 `auth.cookie.secure` 与外部协议对齐（CSRF 协议二选一）。

### 3.3 明确不做（ADR-0004 / 04 §5）

- 一进程 N 租户（内核没有事件作用域）。
- `X-Forwarded-For` 可信代理解析。
- 租户级配额 / 限流 / KMS / 数据行级权限。
- 跨租户返回 404（认证层 401，资源层不可达）。

## 4 复跑入口

```bash
NODE_EXTRA_CA_CERTS= pnpm test          # 255 文件 / 2848 例
NODE_EXTRA_CA_CERTS= pnpm test:snapshot # 8 文件 / 34 例
NODE_EXTRA_CA_CERTS= pnpm gate          # 44/44
NODE_EXTRA_CA_CERTS= npx tsx scripts/tenant-matrix.ts      # 8/8 PASS
NODE_EXTRA_CA_CERTS= npx tsx scripts/verify-tenant-isolation.ts --self-test
```

> 证据纪律：本目录的每个"已修复"都有改前/改后对照；失败/跳过/凑合的条目写在各单
> `*-review.md` 的"不声称"与偏差表里。数字带取证时点；`gates.txt` 是最终一次全量输出。
