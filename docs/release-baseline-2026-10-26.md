# C01 发布基线回执（2026-10-26）

> 结论：**本地收口完成（L2）；远端推送、远端 tag 与两张截图卡在 GitHub 凭证，标【待】。**
> 不写"基本完成"——没做的逐条写在 §7，卡在哪一层写清楚。

## 1. 开工基线（原始输出）

```text
$ git status -sb
## main...origin/main [ahead 34]

$ git log -1 --format='%h %ad %s' --date=short
be877f0 2026-10-26 docs(readme): 刷新对外三份事实源（facts/README/deploy 停在 10-24 的旧数）

$ git remote -v
origin  https://github.com/YYYPROBEE/bah-monorepo.git (fetch)
origin  https://github.com/YYYPROBEE/bah-monorepo.git (push)

$ git tag -l
v1.0-submit

$ git rev-list --count origin/main..HEAD
34
$ git rev-list --count v1.0-submit..HEAD
36
```

与任务书 §0.1 基线一致：HEAD `be877f0`、`origin/main` 落后 34、`v1.0-submit` 落后 36、全仓 1 个 tag。

## 2. 备份与安全检查

### 2.1 可回滚备份

```text
$ git bundle create ../bah-backup-2026-10-26.bundle --all
（成功，无输出）

路径：D:\项目集\微众杯银行ai智能体\BAH\bah-backup-2026-10-26.bundle
大小：3,575,911 字节
时间：2026-10-26 23:03:08
```

### 2.2 敏感文件入库检查

```text
$ git ls-files | grep -iE "\.env|sessions/|snapshots/|\.tmp"
.env.example
snapshots/.gitkeep
snapshots/README.md
snapshots/fixtures.test.ts
snapshots/headless-basic/{llm.jsonl,reverified.json,scenario.json,scenario.ts,session.jsonl,snapshot.test.ts}
snapshots/plan/{llm.jsonl,reverified.json,scenario.json,scenario.ts,session.jsonl,snapshot.test.ts}
snapshots/sandbox-compute/{llm.jsonl,overlay.yml,reverified.json,scenario.json,scenario.ts,session.jsonl,snapshot.test.ts}
snapshots/web-channel/{llm.jsonl,overlay.yml,reverified.json,scenario.json,scenario.ts,session.jsonl,snapshot.test.ts}
（以上为 30 行原始命中，此处按目录折叠）
```

判定：

- `.env.example` 只有占位符 `BAH_MODEL_KEY=` 与 `sk-...` 注释，不是真实密钥；
- `snapshots/` 是**有意的测试夹具**，不是运行时残留；
- `sessions/` 命中 **0** 个文件，`.tmp` 命中 **0** 个文件；
- `.env.local` 未入库、无历史：

```text
$ git check-ignore -v .env.local
.gitignore:5:.env*	.env.local

$ git log --all --oneline -- .env.local
（空）
```

密钥痕迹扫描（仅入库文件，`git grep`）：

```text
$ git grep -n -I -E "sk-[A-Za-z0-9]{10,}|BAH_MODEL_KEY=sk|api[_-]?key[[:space:]]*[:=][[:space:]]*.{16,}" -- . ':!pnpm-lock.yaml'
.env.example:6:#   BAH_MODEL_KEY=sk-...
.env.example:14:#   BAH_MODEL_KEY=sk-...
packages/safety/src/sentry/kernel/pii.test.ts:42: const [compiled] = vault.compile('密钥 sk-abcdefghijklmnop1234 ...')
packages/safety/src/sentry/kernel/pii.test.ts:45: original: 'sk-abcdefghijklmnop1234',
```

三处均为占位或测试假值，**无需 `git rm --cached`，本轮未删除任何本地文件**。

## 3. 交付包边界三问（各一行结论）

| 问题 | 结论 | 依据 |
|---|---|---|
| `sessions/`、`snapshots/` 进不进交付包 | **`snapshots/` 进，`sessions/` 不进** | `snapshots/` 已入库 29 个文件、5 个测试文件 / 18 个用例（4 个回放场景），`snapshot-fresh` 门禁依赖它；`sessions/` 入库 0 个、被 `.gitignore:7` 忽略、本机 1080 个运行期演示目录（2026-10-26 23:18 实测，随演示增长），属于可再生的本地数据 |
| `bah-audit/`、`sentry-dsh-plugin/` 算交付件还是参考件 | **均为参考件，不进交付包** | 两者都是 MonoRepo 之外的独立 git 仓库；`docs/audit.md:15-16` 明写"bah-audit 不参与本仓证据"，`PROGRESS.md:2575` 记"仓库外层、不参与本仓证据（剥离归 W20）"；`NOTICE.md:7` 说明 sentry 内核已迁入 `packages/safety`，提交包不需要第二份源码 |
| `.env.local` 的 key 轮换 | **【待】本人操作** | `.env.local` 被 `.gitignore:5` 忽略且无历史；轮换涉及真实密钥，agent 只看存在性、不读值、不改值 |

`.env.local` 轮换检查清单（交给本人）：

1. 替换或删除 `.env.local` 里的 `BAH_MODEL_KEY`（旧 key 视为已暴露风险）；
2. 用新 key 跑一次 Web 冒烟，确认第一次调模型不再报"未配置密钥"；
3. 确认 `git status` 里 `.env.local` 仍为 ignored；
4. 确认新 key 没有写进任何 profile、脚本或文档。

## 4. 对外三处

### 4.1 README 顶部仓库地址

```text
README.md:3: > 仓库：https://github.com/YYYPROBEE/bah-monorepo（访问需授权）
README.md:4: > 许可：仅授权赛事评审查看与运行，见 [LICENSE](LICENSE)
```

### 4.2 部署文档 clone 地址

```text
docs/deploy.md:10: ## 0. 获取代码
docs/deploy.md:13: git clone https://github.com/YYYPROBEE/bah-monorepo.git
docs/deploy.md:17: 仓库访问需授权。不要把 token 写进 clone URL 或任何文件；`.env.local` 不入库。
```

### 4.3 LICENSE

- 选择：**"仅参赛评审使用"**（非 MIT、非 Apache-2.0）。
- 理由：本仓是银行场景演示系统，赛后若默认开源会被任意复用；赛事只要求评审可查看/运行，不要求授予再分发权。该选择由用户在本轮明确指定，agent 未代选。
- 文件：仓库根 `LICENSE`，含授权范围、终止条件、免责声明三段。

## 5. 验收

### 5.1 命令与结果

| # | 命令 | 期望 | 实测 | 判定 |
|---|---|---|---|---|
| 1 | `git rev-list --count origin/main..HEAD` | 0 | 34（提交前）/ 35（提交后，未推） | **未达成**——推送卡凭证，见 §7 |
| 2 | `git rev-list --count v1.0-submit..HEAD` | 0 | 0（本地 tag 重打后） | 本地达成；远端 tag 未更新 |
| 3 | `git ls-remote --tags origin \| grep v1.0-submit` | 命中 | `fatal: Authentication failed`（`Repository not found`） | **未达成**——见 §7 |
| 4 | `grep -rn "github.com" README.md docs/deploy.md` | 非空 | 2 处命中（README:3、deploy:13） | 达成 |

### 5.2 门禁

```text
$ NODE_EXTRA_CA_CERTS= npx tsx scripts/run-gates.ts
...
✔ web
全部通过（34/34）
```

### 5.3 负例（tag 指向必须真是 HEAD）

```text
$ git rev-parse v1.0-submit~1
edf2ba90262e85163c4a4ce1a34709ddcf5b2a8a
$ git rev-parse HEAD
be877f042d82b1019bd864f8af087ba06e321a30
```

两者不同 ⇒ 旧 tag 不指向当前 HEAD。本地重打后必须复核：`git rev-parse v1.0-submit^{commit}` 等于 HEAD，
且 `git rev-parse v1.0-submit~1` 不等于 HEAD；若相等，说明 tag 没真指向新提交。

## 6. 本地 tag 重打

```text
$ git tag -d v1.0-submit
Deleted tag 'v1.0-submit' (was b098a3a)
$ git tag -a v1.0-submit -m "submit 2026-11-02"
```

- 本地 tag 已指向本包提交；
- **远端旧 tag 未删除**（需凭证）——推 tag 前必须先 `git push origin :refs/tags/v1.0-submit`，否则会因非快进被拒。

## 7. 失败层（未闭合，按 §6.4 写到层）

### 7.1 远端推送：GitHub 凭证层

```text
$ git ls-remote origin -h refs/heads/main
fatal: User cancelled dialog.
remote: Repository not found.
fatal: Authentication failed for 'https://github.com/YYYPROBEE/bah-monorepo.git/'

$ GIT_TERMINAL_PROMPT=0 git push origin main
fatal: User cancelled dialog.
remote: Repository not found.
fatal: Authentication failed for 'https://github.com/YYYPROBEE/bah-monorepo.git/'
```

**层级判定：不是 DNS、不是 TLS、不是 403、不是分支保护，而是 401 认证失败。**
已核实：`git config credential.helper` = `manager`；Windows 凭据管理器里只有 `git:https://gitee.com`，无 github.com 条目；
`GITHUB_TOKEN` / `GH_TOKEN` 均不存在；`gh` CLI 未安装。

处置：按用户决定"先跳过推送，本地收口"。远端推送与远端 tag 更新标【待】。

### 7.2 截图

| 截图 | 状态 | 原因 |
|---|---|---|
| 仓库可见性页 | 【待】 | 需 GitHub 登录；匿名访问返回 `Repository not found` |
| Actions 页（secret / e2e 是否恒 SKIP） | 【待】 | 同上；本地只能确认 CI 引用 `secrets.DEEPSEEK_API_KEY`，且 `ci.yml:7` 注明无密钥时 e2e 显式 SKIP |

本地可确认的 CI 事实（替代不了 Actions 截图）：

```text
.github/workflows/ci.yml:33: DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
.github/workflows/ci.yml:7:  # - e2e 无 DEEPSEEK_API_KEY 时显式 SKIP（不算绿）；有密钥时零用例会红；
.github/workflows/ci.yml:82-83: # 严格模式：未执行面（如无密钥的 e2e）不得算绿……
```

计划截图文件名（待补，当前未生成）：release-2026-10-26/repo-visibility.png、release-2026-10-26/actions.png。

### 7.3 提交阻塞：并发工作流留下的未跟踪测试（不属 C01）

2026-10-26 23:14 复跑门禁时，`tracked-sources` 由绿变红：

```text
✘ tracked-sources
· packages/cli/src/cli/audit-replay.test.ts: 源码未纳入版本库（git add 后重跑；干净 clone 会直接缺文件）
· packages/persistence/src/replay/replay.test.ts: 源码未纳入版本库（git add 后重跑；干净 clone 会直接缺文件）
ℹ 已核对 676 个源码文件、1803 条相对导入；未跟踪源码 2 个
阻断合并：2/34 项未通过
```

另有至少 8 个 `packages/**` 测试文件在本包施工期间被改动或新建（23:11–23:24 仍在增长，非 C01 所为），
例如：`packages/bank/src/core/mock.test.ts`、`packages/host/src/boot/plugins/knowledge.test.ts`、
`packages/interaction/src/approval/ticket-ledger.test.ts`、`packages/knowledge/src/sign.test.ts`、
`packages/knowledge/src/verify-port.test.ts`、`packages/runtime/src/session/service.test.ts`。

处置：按用户决定**等并发工作流收口**。C01 未 stage、未提交这些文件，也未修改或删除它们；
C01 的 5 个文件保持未提交状态，待并发工作流结束后再跑门禁、提交、重打本地 tag。

## 8. 复跑方式

```bash
git rev-list --count origin/main..HEAD
git rev-list --count v1.0-submit..HEAD
git ls-remote --tags origin | grep v1.0-submit
grep -rn "github.com" README.md docs/deploy.md
NODE_EXTRA_CA_CERTS= npx tsx scripts/run-gates.ts
git rev-parse v1.0-submit^{commit}; git rev-parse HEAD
```

## 9. 双角度复审（提交前）

### 9.1 视角 A：立据（数字与行号真不真）

| 断言 | 复核命令 | 结果 |
|---|---|---|
| 开工基线 HEAD/落后/tag 与任务书一致 | `git log -1`、`git rev-list --count`、`git tag -l` | 一致：`be877f0`、34/36、仅 `v1.0-submit` |
| bundle 是完整历史且可校验 | `git bundle verify ../bah-backup-2026-10-26.bundle` | `The bundle records a complete history.` |
| 敏感面命中 30 行，`sessions/` 与 `.tmp` 入库为 0 | `git ls-files \| grep -iE ...` | 30 行 = `.env.example` + 29 个 `snapshots/` 文件；`sessions/` 0、`.tmp` 0 |
| `.env.local` 被忽略且无历史 | `git check-ignore -v`、`git log --all -- .env.local` | `.gitignore:5` 命中；历史为空 |
| `snapshots/` 入库 29 个、5 个测试文件 / 18 个用例 | `git ls-files snapshots` + README §7 | 29 个；5 个测试文件（`fixtures.test.ts` + 4 个 `snapshot.test.ts`） |
| 边界判定引用的三处原文存在 | `docs/audit.md:15-16`、`PROGRESS.md:2575`、`NOTICE.md:7` | 均逐行确认 |
| CI 的 secret 与 e2e SKIP 注释存在 | `.github/workflows/ci.yml:7/33/82-83` | 均逐行确认 |
| 地址命中 2 处 | `grep -rn "github.com" README.md docs/deploy.md` | README:3、deploy:13 |
| 门禁 34/34 | `NODE_EXTRA_CA_CERTS= npx tsx scripts/run-gates.ts` | 23:09 首跑 34/34；23:14 因并发文件变红，见 §7.3 |
| 旧 tag 是 annotated tag，指向 89f0c75 | `git cat-file -p v1.0-submit` | `object 89f0c75`、`tagger YYY_project`、原 message“BAH 参赛提交基线：阶段一工程纪律闭环” |

### 9.2 视角 B：覆盖（C01 九步逐条）

| 步骤 | 状态 | 证据 / 缺口 |
|---|---|---|
| 1 bundle 备份 | 完成 | §2.1，verify 通过 |
| 2 敏感文件检查 | 完成 | §2.2，无需 `git rm --cached` |
| 3 交付包边界三问 | 完成 | §3，三行结论 + 依据 |
| 4 凭证来源确认 | 完成 | manager；无 github.com 条目；无 TOKEN；无 gh |
| 5 `git push origin main` | **未完成** | §7.1，401；用户决定跳过 |
| 6 重打 tag | **本地待执行，远端未完成** | §6；本地待提交后重建，远端需先删旧引用 |
| 7 README + deploy 地址 | 完成 | §4.1、§4.2 |
| 8 LICENSE | 完成 | §4.3，用户选择“仅参赛评审使用” |
| 9 两张截图 | **未完成** | §7.2，需 GitHub 登录 |

### 9.3 复审当场修正

1. `sessions/` 目录数从 1069 变为 1080（并发演示造成），已在 §3 改成带时间戳的实测值，并注明会随演示增长。
2. 旧 tag message 与新 tag message 不同，已在 §9.1 记录旧 message，避免复核者以为 tag 被静默改写。
3. `git rev-parse v1.0-submit` 返回的是 tag 对象（b098a3a），不是提交；最终复核统一用 `v1.0-submit^{commit}`，见 §5.3 与 §8。
4. 并发工作流的 6 个 `packages/**` 改动不属于 C01，已单列 §7.3，未纳入本包提交。
