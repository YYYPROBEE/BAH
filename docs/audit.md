# `bah audit` 命令面

> 施工单 16。对任意落盘目录做一次**只读**证据链核验：链连续性、签名覆盖与验签、投影重算、锚定台账比对。
> 命令**不修链、不建库、不迁移、不联网**；跑完被审计目录**零新增文件**（含 `-wal` / `-shm`）。

## 先读这三条

1. **本仓生产链当前为空**（R145）：`bank:tools` 的转账没有接 saga 协调器，`sessions/` 里只有会话流、没有 `audit.jsonl`。所以在本仓直接跑 `bah audit`，默认会报“未找到可审计的链”（退出码 2）——这不是命令坏了。
2. **签名私钥不在仓库**（R146）：缺省路径 `keys/saga-ed25519.pem` 不存在。缺密钥且链上确有应签事件时，命令会明确报 `skipped-no-key` 并以退出码 2 结束；要完整验签，先用下面的命令生成临时密钥，或通过 `--key` 指定已有私钥。
3. **`sessions/saga.sqlite` 当前是空库**（R172）：存在、WAL 模式、0 条事务。库存在但事务为 0 时，链的投影会如实标为 `runtime-missing`，不是异常。

## 用法

```text
bah audit [选项]
```

```bash
# 审仓库默认会话目录（人读）
bah audit --dir sessions

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

## 自证

```bash
pnpm audit:selftest
```

临时目录造一条 42 事件签名链 → 跑审计 → 断言通过 → 校验源目录零新增 → 清理。不触碰 `sessions/`。
