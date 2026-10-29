# 部署与运行说明（M0）

> 读者：拿到仓库、要在自己机器上把演示跑起来的人。
> 本文只写**能照着做**的步骤；所有默认值都回源码核过（`profiles/web/patch.yml`、
> `packages/host/src/boot/`、`scripts/demo-web.mjs`）。
> 最后核实：2026-10-24（Node 22 / pnpm 10.34.7，Windows 与 Linux 同一套命令）。

---

## 0. 获取代码

```bash
git clone https://github.com/YYYPROBEE/bah-monorepo.git
cd bah-monorepo
```

仓库访问需授权。不要把 token 写进 clone URL 或任何文件；`.env.local` 不入库。

---

## 1. 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | `^22.19 \|\| >=24` | `package.json` 的 `engines`；22.17 目前只告警不阻断，但不保证行为一致，建议按 `.nvmrc` 装 22.19 |
| pnpm | `10.34.7` | `packageManager` 字段锁定；用 corepack 或手动装同版 |
| 操作系统 | Windows / Linux / macOS | 脚本用 Node 原生 API，没有平台分支 |
| 网络 | Web 与 headless 主路径都不需要外网 | 默认走离线路由（`provider: router`）；只有切 DeepSeek 时才需要外网 |

```bash
corepack enable
pnpm install          # 同时把 core.hooksPath 指到 .githooks
```

`pnpm install` 的 `prepare` 会执行 `git config core.hooksPath .githooks`；
之后提交跑 `pnpm gate`（40 项），推送跑 `pnpm check`（14 步）。钩子挡疏忽，不挡 `--no-verify`。

---

## 2. 两个端口

| 端口 | 谁在用 | 绑定 | 改哪里 |
|---|---|---|---|
| `7331` | Web 渠道（页面 + `/api/*`） | `127.0.0.1` | `profiles/web/patch.yml` 的 `channel:web.config.port` |
| `7801` | 知识 RAG sidecar（可选） | `127.0.0.1` | `profiles/web/patch.yml` 的 `bank:knowledge.config.baseUrl` |

- 端口被占时**不会自动换端口**，启动直接报 `web-listen-failed`。这是刻意的：
  换端口会让「答辩时打开的是旧页面」变成可能。
- 前端是纯 ES 模块，静态目录直接指向 `apps/web`，**不需要先 build**。
- RAG sidecar 缺席时知识工具降级为 `knowledge-unavailable`（`required: false`），
  站点仍能起，但「检索增强」只剩空壳——演示前必须确认 7801 探活通过。

---

## 3. 环境变量

| 变量 | 必需 | 作用 | 不设的后果 |
|---|---|---|---|
| `BAH_MODEL_KEY` | 否（仅切 DeepSeek 时） | `profiles/web/patch.yml` 注释块里的 `core:model.apiKeyEnv`；真实模型密钥 | 主路径 router 不使用；切 DeepSeek 后缺它会在第一次调模型时报「未配置密钥」 |
| `DEEPSEEK_API_KEY` | 否（仅其他 profile 用 deepseek 时） | 模型插件的缺省 `apiKeyEnv` | 同上 |
| `BAH_KNOWLEDGE_KEY` | 装配 `bank:knowledge` 时必需（W06） | 知识库签名清单的 HMAC 密钥；演示/CI 用公开的 `demo-key-not-for-prod` | 知识插件启动期报 `invalid-config`（无默认密钥） |
| `BAH_WEB_TOKEN` | 否 | `/api/*` 的 Bearer token | 每进程随机生成，注入 `index.html` 的 meta；页面能用，手打 API 需自己取 |
| `BAH_ADMIN_TOKEN` | 否 | 管理路由的**单 token** 凭据（兼容形态；操作员记为 `admin`） | 与下一项都没设 → **路由不存在（404）**，无法远程解冻断路器 |
| `BAH_ADMIN_OPERATORS` | 否 | 多操作员 JSON：`[{"id":"ops-li","token":"…"}]`；优先于 `BAH_ADMIN_TOKEN`，解冻的 `by` 从命中 token 派生 | 未设则回落到 `BAH_ADMIN_TOKEN`；坏 JSON 会让管理面 **503（fail-closed）** |
| `NODE_ENV` | 否 | 设为 `production` 时，sentry 的 `trace.sink=stderr` 会在启动期 fail-loud | 开发默认允许 stderr |

sentry 的 `trace.sink` **没有缺省值**（W08）：三个可运行 profile 都已显式写 `session`。
自定义 profile 漏写会在载入期报 `sentry-trace-sink-required`，进程起不来——这是刻意 fail-loud，
不是本地环境坏了。

Web 响应默认带 CSP / X-Frame-Options / X-Content-Type-Options / Referrer-Policy /
Permissions-Policy；`/api/*` 每来源 60 秒 120 次限流，超限 429。限流窗口与上限可在
`profiles/web/patch.yml` 的 `channel:web.config.rateLimit` 调整。

密钥只从环境变量读，**没有 `--key` 参数**（会进进程列表与 shell history）。
主路径 router **不需要密钥**；只有切 DeepSeek 时才用仓库根的 `.env.local`
（被 `.gitignore` 的 `.env*` 挡住）：

```text
BAH_MODEL_KEY=<your-key>
```

`pnpm demo:web` 会读它；`pnpm web` 不读。两者启动的是同一个 profile。
RAG 的 `BAH_KNOWLEDGE_TOKEN` 是另一回事（见 `docs/knowledge.md`）：sidecar 无 token 拒启，
宿主与 sidecar 必须使用同一个值。

**管理 token 的正确用法**（解冻断路器）：

```bash
# 终端 A：带 token 起 Web（没设就 404）
BAH_ADMIN_TOKEN=<一串随机值> pnpm demo:web

# 终端 B：解冻（03 起不再有 --by：操作者由命中的 token 派生）
# 宿主用 BAH_ADMIN_OPERATORS 时，这里的 BAH_ADMIN_TOKEN 填该操作员的 token
BAH_ADMIN_TOKEN=<同一串> pnpm bah sentry unfreeze --reason "客服复核：误报"
```

- 只绑回环：非 `127.0.0.0/8` / `::1` 来源一律 403；
- token 走 `timingSafeEqual`，长度先判；
- **headless 没有 HTTP 服务，冻结只能重启进程**——不要讲「CLI 能解 headless」。

---

## 3.1 saga 审计签名密钥（W12 起补偿需要）

`saga/comp-issued` 与 `saga/comp-result` 在 Ed25519 签名白名单里（`packages/persistence/src/chain/index.ts` 的
`SIGNED_TYPES`）。W12 打开自动冲正后，补偿提交会写这两类事件；默认路径
`keys/saga-ed25519.pem` 不存在时，补偿会以 `commit-failed: signing-key-missing` 失败
（正向交易不受影响，因为它不写签名事件）。

开发 / 演示两条路（B5，2026-10-27）：

```bash
pnpm demo:web                            # 自动：在本次 runDir/keys/ 生成一次性密钥（0600），
                                         # 并用 --patch 把 bank:saga-audit.signingKeyPath 指过去；
                                         # 验签用 demo:web 打印的 --key 路径
npx tsx scripts/gen-saga-key.ts          # 手动：写 keys/saga-ed25519.pem（0600；keys/ 已被 .gitignore 忽略）
```

`demo:web` 的一次性密钥只对本 run 的链负责，不进仓库、不打印内容；密钥生成失败时退回
缺钥行为（补偿 `commit-failed: signing-key-missing`）并在启动日志说明，不会静默。
`pnpm web`（非 demo）不做自动生成，按需走手动路径。

- 自定义路径：`bank:saga-audit.config.signingKeyPath`（验签命令要用同一把私钥）；
- 私钥**不得提交**；仓库当前没有 KMS/HSM，生产托管留待后续（如实写，不要声称已有）。

### 3.2 知识库签名密钥（W06 起 `bank:knowledge` 需要）

知识库签名清单用 HMAC-SHA256；密钥只从 `BAH_KNOWLEDGE_KEY` 读，**库代码没有默认密钥**：

```bash
# 本地 shell（.secrets/ 已被 .gitignore 忽略）
mkdir -p .secrets && openssl rand -hex 32 > .secrets/knowledge.key
export BAH_KNOWLEDGE_KEY=$(cat .secrets/knowledge.key)
npx tsx scripts/sign-knowledge.ts        # 用这把密钥重新签名
```

- **演示脚本**（`scripts/demo-rag.mjs` / `scripts/demo-web.mjs`）在未设置时注入公开的
  `demo-key-not-for-prod` 并打印警告——只能用于完整性演示，不是秘密；
- **CI**：`.github/workflows/ci.yml` 的 `env:` 注入同一个固定测试密钥，并跑
  `pnpm knowledge:sign --check`；
- **换密钥即失效**：清单的 `keyId` 与 HMAC 都绑定密钥，换钥必须重签，否则启动报
  `knowledge-signature-key-mismatch`；
- 无 KMS/HSM；生产应把密钥放进部署平台的 secret 存储，并在发布流程里重签。

---

## 4. 五条命令

### 4.1 起 Web 演示（离线 router）

```bash
pnpm demo:web
# [demo:web] 本次会话目录：.../sessions/demo-<stamp>-<随机>/
# 打开 http://127.0.0.1:7331
```

默认 `provider: router`：不读密钥、不依赖外网，只认查余额 / 转账。需要 Web 内真实模型
（含知识问答）时，按 `profiles/web/patch.yml` 注释把 `core:model` 与 `core:agent.loop.model`
**两处**换成 DeepSeek，并在 `.env.local` 写 `BAH_MODEL_KEY`。

每次演示都会新建独立会话目录，日志、Saga 库与审计链都落在该目录；结束后按终端打印的
`pnpm bah audit --dir "<目录>"` 复核，不会把上一场的钱记到这一场。预期：对话流两段气泡、
工具卡三态、黄级转账弹审批（六要素）、票据核销、审计时间线。

### 4.2 起 Web（不读 `.env.local`）

```bash
pnpm web
```

CI 或需要从外部环境变量注入密钥时用这条（默认 router 不需要密钥）。

### 4.3 跑一段 headless 对话（离线、无密钥）

```bash
pnpm bah --profile headless --prompt "给王建国转 800 元"
```

headless 走 `provider: router`（读消息现规划，不是固定磁带），不需要网络。
审批是自动应答（`autoDecision: allow`）——**仅演示/快照用，不是生产默认**。

### 4.4 一键自证（不需要密钥）

```bash
pnpm test              # 255 文件 / 2848 用例（2026-10-29 实测；前端另有 55 例）
pnpm test:snapshot     # 7 场景 / 8 文件 34 例，录制↔回放逐条全等
pnpm gate              # 42/42
pnpm demo:verifier-fail # 判决件异常 → 结果被挡在模型之外（20 条断言）
```

### 4.5 容器起 Web（Docker / Compose）

```bash
# 单容器（最小路径）
docker build -t bah:local .
docker run --rm -p 7331:7331 bah:local    # 默认离线 router，不需要 BAH_MODEL_KEY

# 编排（D3）：web 默认起；RAG sidecar 在 `rag` profile 里，按需开
docker compose up -d web
docker compose --profile rag up -d
docker compose logs -f web
docker compose down
```

- `docker-compose.yml` 只做**单机演示编排**：没有多副本、没有负载均衡、没有 K8s。
  `sessions/` 挂命名卷（会话与审计链是证据，容器重建不能丢）。
- **两个容器必须用同一个 `BAH_KNOWLEDGE_TOKEN`**：sidecar 读 `BAH_RAG_TOKEN`，缺省回落到
  `BAH_KNOWLEDGE_TOKEN`（`auth.py` 的 legacy 分支），所以演示只需设这一个；host 侧 `bank:knowledge`
  读的也是它。不设 = sidecar 拒启（fail-loud），不是"演示时关掉认证"。
- RAG 的 `services/rag/models/`（约 182MB）与 `data/` 用**只读绑定**挂进去，不进镜像也不进卷；
  干净 clone 里没有 `models/` 时 rag 会启动失败——有意如此。
- 镜像内把 `profiles/web/patch.yml` 的 `channel:web.config.host` 改为 `0.0.0.0`
  （仓库默认 `127.0.0.1` 无法被 `-p 7331:7331` 访问到）。挂载宿主 profile 会覆盖这处改动。
- 管理路由仍只接受回环来源：经端口映射进来的请求来自 docker 网桥，会 403。演示不需要管理路由。
- 源码直跑（tsx），**不产出也不需要 `dist`**：`@bah/*` 由根 `tsconfig.json` 的 `paths` 解析到
  `packages/*/src`（`dist/` 与 `dist-types/` 本就被 `.gitignore` 忽略，干净 clone 本来就没有）。
  `--ignore-scripts` 只为跳过根 `prepare`（容器内无 `.git`），依赖树无原生模块。
- 回滚：`docker tag bah-web:local bah-web:<日期>`；回滚 = `docker compose down` + 跑回上一个 tag，
  并把 `sessions` 卷指回原目录（**不要**在回滚时清理卷：那会连带删掉审计证据）。

**验证状态（必须照实说）**：本机**没有 Docker CLI**，`docker build` 一次都没跑过。
只做了静态核对，逐条可复核：

| 静态核对项 | 结论 |
|---|---|
| `docker-compose.yml` 能否解析 | ✅ `yaml` 解析通过；services = web / rag；rag 在 `rag` profile |
| 挂载路径是否存在 | ✅ `services/rag/data`、`services/rag/models` 都在 |
| Dockerfile 的 `sed` 目标行 | ✅ `profiles/web/patch.yml:127` 恰为 `    host: 127.0.0.1` |
| RAG 健康检查路径 | ✅ `main.py` 有 `@app.get("/healthz")`（匿名） |
| 凭据变量名 | ✅ `auth.py`：`BAH_RAG_TOKEN` → 回落 `BAH_KNOWLEDGE_TOKEN` |
| 运行期是否需要 `dist` | ✅ 不需要（tsconfig `paths` 直指 `src`；`dist` 本就不入库） |
| pnpm 版本 | ✅ `packageManager: pnpm@10.34.7` 与镜像内 `corepack prepare` 一致 |

首次构建请在**有 Docker 的机器**上按顺序跑，并把输出补回本节：

```bash
docker build -t bah-web:local . && docker images bah-web:local --format '{{.Size}}'
docker run --rm -d --name bah-smoke -p 7331:7331 bah-web:local
sleep 15 && curl -s http://127.0.0.1:7331/api/health   # 期望 {"ok":true,...}
docker rm -f bah-smoke
```

在拿到上面那次 `/api/health` 之前，**仓库不声称"镜像可起"**。

### 4.6 只读核验证据链

```bash
pnpm bah audit --dir "<demo:web 打印的会话目录>" --no-signature
pnpm bah audit --dir "<demo:web 打印的会话目录>" --key "<demo:web 打印的一次性密钥路径>"   # 完整验签（B5）
```

`--no-signature` 只验链连续性与投影（退出码 0，签名状态 `skipped-disabled`），**不等于验签通过**。
完整验签需要私钥；仓库不带私钥，缺密钥时命令报 `skipped-no-key` 并以退出码 2 结束，不是命令坏了。
转账已接 saga，演示目录里会有 `<sagaId>/audit.jsonl` 与 `saga.sqlite`；W08 起同一目录还会有
`<sessionId>/audit.jsonl`（`tool/call` + `sentry/decision` + `approval/decided`）。跑完被审计目录零新增文件。

断链时 `bah audit` 会在 stderr 打 `audit/chain-broken <chainId> brokenAt=<seq>` 并以 1 退出；
运行中的宿主启动扫描发现断链会直接 `HALT(chain-broken)`（无关闭开关）。

---

## 5. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `web-listen-failed` | 7331 被占 | 关掉占用进程，或改 `profiles/web/patch.yml` 的 `port` 后重启 |
| 页面能开，所有 `/api/*` 401 | 页面没拿到 meta token，或手打 API 没带 Bearer | 用页面操作；手打 API 先从 `GET /` 的 `<meta name="bah-web-token">` 取值 |
| 管理路由 404 | `BAH_ADMIN_TOKEN` 没设 | 带上 env 重启 Web |
| 管理路由 403 | 来源不是回环 | 只能从本机调；不要绑 `0.0.0.0` |
| 管理路由 401 | token 不一致 | 两端用同一串；不要带引号/空格 |
| 第一次对话报「未配置密钥」 | 已切 DeepSeek 但 `BAH_MODEL_KEY` 为空 | 写 `.env.local`；或按 profile 注释把 `core:model` 与 `core:agent.loop.model` 成对换回 router |
| 知识问答报 `knowledge-unavailable` | 7801 sidecar 没起 | `pnpm rag:dev`（或按 `services/rag` 的 README 起），再确认探活 |
| 断路器冻结，解不掉 | 在用 headless | headless 只能重启；Web 用管理路由 |
| 提交被 `pnpm gate` 拒绝 | 40 项里有红 | 看输出末段；`docs` 路径红最常见（引用了不存在的文件） |
| 推送被 `pnpm check` 拒绝 | 14 步里有红 | 先 `pnpm test:snapshot`；快照红会卡在最后一步 |
| 演示日志里全是历史转账 | 用 `pnpm web` 起在了共享 `sessions/`；`demo:web` 才会每次新建独立目录 | 改用 `pnpm demo:web`，按打印的目录审计；不要删别人的历史目录 |

---

## 6. 演示前 60 秒检查

```bash
pnpm gate                 # 42/42（不需要 BAH_ALLOW_NO_SNAPSHOT）
pnpm test:snapshot        # 8 文件 / 34 例（录制↔回放逐条全等）
pnpm demo:verifier-fail   # 退出码 0
pnpm demo:web             # 另开终端；记下打印的“本次会话目录”
curl -s http://127.0.0.1:7331/api/health   # 返回 JSON，且不含票据 ID
pnpm bah audit --dir "<本次会话目录>" --no-signature  # 链连续、投影 diff=0
```

另外三条**环境前置**（缺了会当场起不来）：

```bash
echo "$BAH_KNOWLEDGE_KEY"     # 必须非空：知识库签名密钥缺失时 web 直接拒绝启动
netstat -ano | grep ":7331"   # 必须没有 LISTENING：端口占用不会自动换端口
node -v                       # 需要 ^22.19 || >=24
```

八条都过再上台。任何一条红，先修再讲——现场不要靠「应该没事」。

> 模型路径只有一个默认答案：`provider: router`。要改用 DeepSeek，必须把 profile 的
> `core:model` **和** `core:agent.loop.model` **两处一起换**；只换前者会报
> `provider deepseek 未注册`（主循环仍指向旧 provider）。这是手动切换，不是自动降级。
