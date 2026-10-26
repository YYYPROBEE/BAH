# `bah audit` 命令面

> 施工单 16。对任意落盘目录做一次**只读**证据链核验：链连续性、签名覆盖与验签、投影重算、锚定台账比对。
> 命令**不修链、不建库、不迁移、不联网**；跑完被审计目录**零新增文件**（含 `-wal` / `-shm`）。

## 先读这四条

1. **转账已接 saga**：base bundle 的 `bank:saga-bridge` 把 `transfer_create` 接进两步 DAG；一次成功转账会在会话根下生成 `<sagaId>/audit.jsonl` 与 `saga.sqlite`。**同一次会话还会生成 `<sessionId>/audit.jsonl`**（W08 的会话证据链：工具调用 / 安全判决 / 审批结论），两条链各自独立、同一套哈希算法。
2. **每次演示独立目录**：`pnpm demo:web` 每次在 `sessions/demo-<stamp>-<随机>/` 下落链与库，并打印审计命令；`pnpm gate` 用 `.tmp-saga-wiring/` 的独立库，不写 `sessions/`。干净检出时没有链，是正常的。
3. **签名私钥不在仓库**（R146）：缺省路径 `keys/saga-ed25519.pem` 不存在。缺密钥且链上确有应签事件时，命令会明确报 `skipped-no-key` 并以退出码 2 结束；要完整验签，先用下面的命令生成临时密钥，或通过 `--key` 指定已有私钥。
4. **无密钥时怎么拿到绿色**：只想验证链连续性与投影，用 `--no-signature`（签名状态显示 `skipped-disabled`，退出码 0）；这不等于“验签通过”，材料里不要写成完整验签。

## 证据面：一套实现，两类链（W08）

本仓的证据面**唯一实现**是 `packages/persistence/src/chain/`。仓库外层的 `bah-audit/`
不参与本仓证据，也不在 W08 的改动范围内（提交包剥离归 W20）；答辩材料不要把它当第二真相源。

一次会话的链落在同一个会话根，按目录区分：

| 链 | 目录 | 写入方 | 条目 |
|---|---|---|---|
| saga 链 | `<root>/<sagaId>/audit.jsonl` | `bank:saga-audit` | `saga/*`（编排、补偿、恢复） |
| 会话证据链 | `<root>/<sessionId>/audit.jsonl` | `audit:decisions` | `tool/call`（v1）、`sentry/decision`（v2）、`approval/decided`（v2） |

`audit:decisions` 在 boot 期拒绝占用编排链命名空间的会话 ID：`saga-*` 与 `system-startup`
是保留名（否则两类条目会写进同一个 `audit.jsonl`）。换一个会话 ID 即可，不是环境坏了。

**信封 v2**（W08）在 v1 的八个哈希键之上追加：

- `version: 2`：与历史 v1 行区分；
- `subject`：谁被判决（本仓写 `session:<sessionId>`，与 v1 的 `sub`（对象引用）不同）；
- `decision`：`allow | deny | ask`；
- `policyVersion`：判决策略版本（sentry / approval 各自独立）；
- `prevHash`：前一条 `recordHash`，是 v1 短键 `p` 的显式别名，两者必须相等。

v1 行的哈希投影仍是原来的八个键，算法不改，所以**混链**可以逐条验。篡改 v2 的任一字段
（含 `decision` 改为另一个合法值）都会让该条的 `recordHash` 对不上，`brokenAt` 直接给出条目序号。

**断链告警**（W08 §1.3）：

- 运行时启动会扫会话根下全部链；断一条 → 平台事件 `audit/chain-broken` + stderr +
  `safety/halt(reason='chain-broken')`（进程保持可管理，但工具/新 turn 被拒）；
- `bah audit` 对断链在 **stderr** 打 `bah audit: audit/chain-broken <chainId> brokenAt=<seq>`，
  退出码 1；
- 两条路径都**没有关闭检测的开关**。

## 用法

```text
bah audit [选项]
```

```bash
# 审某次演示的独立目录（pnpm demo:web 会打印这个路径）
bah audit --dir sessions/demo-20261024-153000-ab12cd

# 无签名密钥时只验链连续性/投影（不是完整验签）
bah audit --dir sessions/demo-20261024-153000-ab12cd --no-signature

# 只审一条链，机器读
bah audit --dir sessions --saga saga-gate-001 --format json

# 只有链、没有库：跳过投影
bah audit --dir sessions --no-projection

# 显式使用临时密钥
bah audit --dir sessions --key keys/saga-ed25519.pem

# 只验链连续性（已知降级）
bah audit --dir sessions --no-signature

# 帮助
bah audit --help
```

## 选项

| flag | 取值 | 缺省 | 语义 |
|---|---|---|---|
| `--dir <path>` | 目录 | `sessions/` | 待审计的落盘根；链在 `<dir>/<sagaId>/audit.jsonl` |
| `--saga <id>` | saga id | 全部 | 只报告一条链；锚定仍按目录下全部链计算 |
| `--db <path>` | 文件 | `<dir>/saga.sqlite` | 投影重算用的 saga 库；文件不存在则整段跳过投影，绝不新建 |
| `--no-projection` | 布尔 | 关 | 跳过投影重算 |
| `--key <path>` | 文件 | `keys/saga-ed25519.pem` | 验签私钥 |
| `--format <fmt>` | `text` \| `json` | `text` | 输出格式 |
| `--no-signature` | 布尔 | 关 | 跳过验签，只验链连续性 |
| `--help` | 布尔 | — | 打印本帮助（`-h` 同义） |

## 退出码

| 码 | 含义 |
|---|---|
| `0` | 审计通过：链连续、签名通过或明确降级、投影 `diff=0` 或明确未跑、锚定一致或明确未锚定 |
| `1` | 审计发现确定异常：链断、验签失败、类型内缺签名、投影漂移、反向缺口、锚定不符、台账损坏、孤立锚定、链文件损坏 |
| `2` | 用法或环境错误：未知 flag、缺值、`--dir` 不存在或不是目录、没有可审计的链、指定链不存在、缺密钥且未 `--no-signature`、库存在但 schema 不可读 |

优先级：**确定异常（1）> 未完成检查（2）> 通过（0）**。例如一条链断了、另一条缺密钥，退出码是 1；链没有确定异常但缺密钥无法验签，才是 2。

断链时 stderr 一定带 `audit/chain-broken <chainId> brokenAt=<seq>`；这是 W08 的固定告警面，
不随 `--format json` 消失（JSON 只改变 stdout 的报告形状）。

## 签名五态

| 状态 | 含义 | 退出码贡献 |
|---|---|---|
| `verified` | 验签通过（**确有应签行且全部通过**） | 无 |
| `invalid` | 验签失败（数据被改） | 1 |
| `skipped-no-key` | 有应签行，但密钥缺失，验签未完成 | 2（无其他异常时） |
| `skipped-disabled` | 用户显式 `--no-signature`（已知降级） | 无 |
| `unsigned` | **没有应签行**：什么都没签过 | 2（无其他异常时） |

`unsigned` 是补上的那一态。以前"没有应签行"也报 `verified`——一条恰好没有签名可验的链，
在报告里读成了"签名验证成功"。**验了零条不等于验过了**；现在它按"审计未完成"（2）处理。

签名覆盖按**类型内一致性**判定：某白名单类型只要有一条带签名，该类型全部行都必须带；整类无签名视为写入方 `signedTypes` 配置排除，记入 `unsignedTypes` 信息项，不判异常。

## 投影态

| 状态 | 含义 |
|---|---|
| `diff-zero` | 链上重算与库中状态一致 |
| `diff-nonzero` | 投影漂移（计 1） |
| `runtime-missing` | 链存在、库中没有该事务（不判异常，显式标注） |
| `skipped-no-db` | 库文件不存在，整段跳过（不判异常） |
| `skipped-disabled` | 用户 `--no-projection` |
| `skipped-chain-broken` | 链断，投影无意义 |
| `diff-error` | 重算抛错（计 1） |
| `db-invalid` | 库存在但 schema 不可读（退 2） |

库读取遵守零写：干净库用 `file:...?immutable=1` 只读打开；存在活动 `-wal` 时复制 `db` + `-wal`（以及存在的 `-shm`）到临时目录审计，跑完删除。**不会**调用 `createSagaStore`。

## 锚定五态

| 状态 | 含义 |
|---|---|
| `matches` | 台账根与目录下全部链的 Merkle 根一致 |
| `mismatch` | 根不一致（计 1） |
| `ledger-missing` | 台账没有该 period（未锚定，不判异常） |
| `ledger-invalid` | 台账存在但 JSON/形状非法（计 1） |
| `orphan-ledger` | 台账有 period、链上无叶子（计 1） |

叶子集与 `anchor()` 同口径：对目录下**全部链**按 `(sagaId, seqInSaga)` 排序，再按 period 取 `recordHash`。`--saga` 只收窄链报告，不改变锚定叶子集。

## JSON 字段

`--format json` 的字段即契约：

```json
{
  "dir": "sessions",
  "db": "sessions/saga.sqlite",
  "chains": [
    {
      "sagaId": "saga-gate-001",
      "events": 42,
      "chainOk": true,
      "brokenAt": null,
      "signedExpected": 7,
      "signedPresent": 7,
      "unsignedTypes": [],
      "signatureState": "verified",
      "signatureError": null,
      "projectionState": "diff-zero",
      "projectionDiff": 0
    }
  ],
  "anchors": [{ "period": "2026-10", "merkleRoot": "…", "state": "ledger-missing" }],
  "reverseGaps": [],
  "errors": [],
  "dbState": "ok",
  "ok": true,
  "exitCode": 0
}
```

- `reverseGaps`：库里有事务、链上没有（或链为空）的 saga；这是运行时状态失去证据链背书，计 1。
- `errors`：单条链读取/解析失败的可读理由；非空即计 1。
- `dbState`：`ok` / `missing` / `disabled` / `invalid`。

## 生成临时密钥（仅本地验收）

```bash
node -e "const {generateKeyPairSync}=require('node:crypto');const fs=require('node:fs');fs.mkdirSync('keys',{recursive:true});const {privateKey}=generateKeyPairSync('ed25519');fs.writeFileSync('keys/saga-ed25519.pem',privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600})"
```

生产环境不要把临时私钥提交进仓库；`keys/` 应在 `.gitignore` 中。

## 如何独立验证（给监管方的一页纸，W15）

独立验证**不需要启动 Agent、不需要模型密钥、不需要数据库**。只读两类文件：

```text
<root>/<sessionId>/session.jsonl   会话事件（append-only；含 seq）
<root>/<sessionId>/audit.jsonl     判决/工具调用哈希链（audit:decisions）
```

```bash
# 1) 重放：重建 {事件序列, 判决表, 票据表}，与原始事件逐条比对
npx tsx scripts/replay.ts --session <id> --dir <root> --verify
#    等价 CLI：pnpm bah audit replay --session <id> --dir <root> --verify

# 2) 生成监管证据包：events.jsonl / decisions.md / tickets.md + manifest.json
npx tsx scripts/replay.ts --session <id> --dir <root> --pack .ci-artifacts/evidence/<id>
#    离线复核（只读 manifest + 文件，不启动进程内状态）
npx tsx scripts/replay.ts --check-pack .ci-artifacts/evidence/<id>

# 3) 快照 Merkle 抽样 10%：包含证明可离线验证
#    .jsonl 每行一个叶子（会话日志/判决链即此形态），.json 取顶层数组或 snapshots 字段
npx tsx scripts/replay.ts --snapshots snapshots/headless-basic/session.jsonl
```

判定口径：

- `diff=0` 的硬条件：链连续 + 会话 `seq` 连续 + 原始行与 reader 逐条一致；
  任一不满足，退出码 1 并打印 `chain-broken:<序号>` / `seq-gap:<seq>` / `session-event:<行号>`。
- 改/删 `audit.jsonl` 任意一行 → 链在**该行序号**处断裂（哈希链 `r = sha256(p | canonicalJson)`）。
- `manifest.json` 给每个文件的 sha256 / 字节数 / 条数；改一个字节即失配。
- **已知边界（必须如实讲）**：
  1. `session.jsonl` 的普通 `user/message` 没有逐行哈希；改写成另一个合法 JSON 且 seq 不变时，
     单靠重放发现不了——需要证据包的 manifest 在外部锚定（发布到不可变存储/时间戳服务）。
  2. 会话落盘会对 `tool/call.args` / 票据做 PII 脱敏；链上 `d` 是**原始数据**的摘要，
     两者不可直接相等，重放只把它记为 warning，不伪装成"链坏了"。
  3. 跨机器重放需要同一仓库版本；本仓不做镜像分发。

## 自证

```bash
pnpm audit:selftest
```

临时目录造一条 42 事件签名链 → 跑审计 → 断言通过 → 校验源目录零新增 → 清理。不触碰 `sessions/`。
