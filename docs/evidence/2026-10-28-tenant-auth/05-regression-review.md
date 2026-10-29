# 05 · 回归审查（交付后复检）

> 触发：四单（01–04）交付后，用户要求"全面审查是否有回归问题并解决"。
> 基线：`tenant-04-delivery` @ `529a851`（工作树干净）。
> 口径：只认实跑输出；"绿"必须能被下一条命令复现。**审查者与被审者是同一线程**，
> 没有独立第三方；下面每条都给了命令或代码落点，供他人复核。

---

## 1 复跑面（先证明"没坏"，再找"哪里坏"）

| 面 | 命令 | 实测 | 结论 |
|---|---|---|---|
| 类型 | `pnpm typecheck` | host/client/scripts 三套 `tsc -b` 0 错 | 绿 |
| 主仓测试 | `pnpm test` | 255 文件 / 2848 用例，0 失败 | 绿 |
| 门禁 | `pnpm gate` | 44/44 | 绿 |
| 快照 | `pnpm test:snapshot` | 8 文件 / 34 例 | 绿 |
| 快照复核 | `pnpm snapshot:reverify` | 写入 0 / 未变 7 | 绿，零改写 |
| 前端 | `pnpm test:web` | 7 文件 / **57** 例 | 绿（原文档写 55） |
| 评测 | `pnpm eval:unit` | 22 文件 / **158** 例 | 修复前 2 红；现绿 |
| 评测冒烟/基线 | `pnpm eval:smoke` / `pnpm eval:baseline` | 报告落 `.ci-artifacts/eval/`；基线 taskSuccess 49/49 等全满足 | 绿 |
| lint | `pnpm lint` | 0 报错 | 绿 |
| 断言基线 | `verify-assertions` | 8335 → 8335（269 文件） | 零漂移 |
| 隔离矩阵 | `tenant-matrix` | 8/8 PASS（M1–M8） | 绿 |
| 隔离门禁自检 | `verify-tenant-isolation --self-test` | 4 坏样本全抓 / 3 合法样本不误报 | 绿 |

真实进程补测（根测试不覆盖的默认模式）：

- **`static` 模式**（缺省，A3 零回归）：`GET /` 有 `bah-web-token`、无 `bah-auth-mode`；
  无凭证 401 / 带 Bearer 200；未知 `/api/*` 无凭证 401、有凭证 404；
  `POST /api/auth/login` → 409 `web-auth-disabled`；`POST /api/turn` → 202；
  SSE `?token=` 200；会话落 `<deploy>/demo/<sid>/`（无平铺目录）；`/api/metrics.tenant=demo`。
- **审批链**：黄级转账签票 → `/api/approval/<id>` 200 → 链上 `approval/decided`；
  静态服务主体不写 `approval/actor`，`bah audit` 如实打 `→ allow → machine` 并提示
  "人批必有主"；`bah audit replay --tenant demo --verify` 退出 0。
- **隔离标记**：`saga.tenant` 落在部署根（`<deploy>/saga.tenant`），`memory.db` 在租户根
  （`<deploy>/<tenant>/memory.db`）——与 `docs/tenant.md` §2 的树一致。

---

## 2 找到并修复的问题

| # | 级别 | 问题 | 证据 | 处置 |
|---|---|---|---|---|
| RG-01 | **P1** | `packages/eval/tests/replay` 仍按平铺 `root/<sid>` 建/读会话；租户化后实际在 `root/demo/<sid>`，`TC-W15-01/02/03` 共 2 例红（`eval:unit` 22 文件 / 2 failed） | `pnpm eval:unit` 原始输出 | 测试改用 `join(root, DEFAULT_TENANT_ID)` 作为 `replaySession.root`；**不改重放 API**；修后 158/158 |
| RG-02 | P1 | 对外材料写"前端 55 例"，实测 **57**（02 加了 web 测试但 facts/README/deploy/self-assessment/testing 未同步） | `pnpm test:web` → 57 passed | 相关文档七处统一为 57；`facts-sources` 同步；docs 门禁加"55 例"过期规则 |
| RG-03 | P2 | `docs/tenant.md` §2 目录树把 `saga.sqlite` / `saga.tenant` 画进租户目录；实际在**部署根**（与同节正文、`tenant-model.md` §5.1 矛盾） | 实跑 `ls`：`<deploy>/saga.sqlite`、`<deploy>/saga.tenant`、`<deploy>/demo/memory.db` | 树改为部署根两项 + 租户根；补旧平铺迁移命令 |
| RG-04 | P2 | README / self-assessment / roadmap 仍称"没有真实登录、无租户、没有租户隔离、不是登录" | 文本与代码事实冲突（02/01/03/04） | 改成三种认证模式 + 角色矩阵 + 租户=部署边界；"不做"只留一进程 N 租户 / OS 隔离；roadmap 加"已落地"横幅 |
| RG-05 | P2 | `docs/web-frontend.md` §7.2 只写 Bearer/static；闸顺序仍写 "Bearer 401 → CSRF"；CSRF 表把期望值写成"进程令牌"（password 登录后是**会话值**） | 代码 `authorize()` / `csrfExpectation()` | 重写 §7.2 为 static/password/none 三模式；顺序改"身份 401 → 角色 403 → CSRF"；新增 §7.2.3 角色与唯一判定点；CSRF 期望值按模式区分 |
| RG-06 | P2 | `docs/deploy.md` / `docs/tenant.md` 没有 password 模式的可执行步骤（`auth.mode`、`auth/users.yml`、`auth-hash.ts`、目录路径相对 cwd） | `profiles/web/patch.yml` 注释是当时唯一说明 | deploy 增"认证模式"段；tenant.md 增 §3.1（三步切换、角色、两租户两份目录文件） |
| RG-07 | P2 | `policy:shadow` / `policy:explain` 文档示例仍给部署根（`sessions/<dir>`）；实现要的是租户目录 | `policy-admin-lib.ts` 的 `listSessions` 只扫一层 | 示例改 `<tenant-sessions>`（如 `sessions/demo`）；`policy-shadow` 用法串同步 |
| RG-08 | P2 | `docs/audit.md` 选项表漏 `--tenant`；`--dir` 语义仍写 `<dir>/<sagaId>/...`；多条示例没带租户 | `audit.ts` 的 `--tenant`（缺省 demo） | 补 `--tenant` 行；`--dir` 改为部署根 + `<tenant>/<sessionId>`；示例统一带租户 |
| RG-09 | P3 | 门禁数旧数残留：README "40 项/40 个"、deploy 42/42、policy "40 项" | `grep` + docs 门禁 | 统一 44；docs 门禁新增 40/41/42/43 过期规则 |
| RG-10 | P3 | `docs/knowledge.md` 只写共享 `BAH_KNOWLEDGE_TOKEN`，未写 per-tenant 变量与非 demo fail-loud | `knowledge.ts` `resolveKnowledgeTokenEnv` | 补 `BAH_KNOWLEDGE_TOKEN_<TENANT>` 与 `knowledge-token-shared` |
| RG-11 | P3 | `docs/contracts/tenant-model.md` 称 `SessionIdentity.tenantId` 的判定在 `authorize()`；实际在 `governance.evaluateCall()`（早于 `no-identity`） | `packages/bank/src/tools/governance.ts:514-527` | 改正判定点，并写明 HTTP 路由级 `authorize()` 不判租户 |
| RG-12 | P3 | `docs/observability.md` 未列 `tenant` 键、Bearer 写法未区分模式 | `/api/metrics` 返回 `tenant`（matrix M7） | 补 `tenant` 键行与模式限定 |
| RG-13 | P2 | `scripts/replay.ts --tenant` 新增后未做 `isTenantId` 校验，`--tenant ../demo` 可把路径拼出部署根；`bah audit replay` 有校验、脚本没有，两入口判据不一致 | 实跑 `npx tsx scripts/replay.ts --session s-x --tenant ../demo` 原本会继续走文件读取 | 在拼路径前校验并退出 2；实测输出 `replay: --tenant 的值不是合法租户 ID：../demo`、`exit=2` |

防止同类再犯：

- `scripts/verify-docs-consistency.ts` 的扫描面从 14 份扩到 19 份（新增
  `security-design` / `web-frontend` / `tenant` / `tenant-model` / `policy`）；
- 过期数字规则加 40/41/42/43 与 `sessions/<sessionId>/`、web 55 例、eval 155 例；
- 能力口径规则加"没有真实登录 / 没有租户隔离 / 多租户要按租户分区 / 单用户部署成立 /
  鉴权性质=不是登录"；
- 负控（外部）：合成 README 同时含 `42/42`、`没有真实登录`、`sessions/<sessionId>/` →
  门禁红且三条都命中；换成 `44/44` + 正确表述 → 绿。

---

## 3 未解决 / 不声称

### 3.1 与 `main` 的合流风险（**未做合并**）

四单链的分叉点是 `6af6d64`；`main` 已前进到 `cbdced4`（可观测性两提交）。实测：

- `git merge-tree cbdced4 529a851` → **22 个冲突文件**，含 7 个代码文件
  （`router.ts` / `dispatch.ts` / `deps.ts` / `audit-decisions.ts` / `persistence.ts` /
  `util/index.ts` / `chain-file.ts`）、6 份 `reverified.json`、`assertion-baseline.json`、
  以及 README / facts / 多份 docs；
- `main` 新增 `/api/trace` 是 `auth: 'web'` 但**没有声明 `roles`**（`router.ts:173-181`）。
  本链的 `verify-authz-coverage` 会因此红（`auth === 'web' && roles === undefined`），
  合并时必须补角色；否则"已认证即可访问"会绕过 03 的路由角色契约；
- 合并后门禁数应为 45（本链 44 + 可观测性 1），facts / README / deploy / 快照
  `reverified.json` 与断言基线都要重生成，不能手工合并数字。

**结论**：这是交付顺序问题，不是本链回归。本链自身可独立复跑；要不要现在把 `main`
合进 `tenant-04-delivery`（并补 `/api/trace` 的 roles）需要另行拍板，未在本轮执行。

### 3.2 其它不声称

- 本审查由主线程自审，**审查者与被审者未分离**；结论靠命令复核，不靠"我看过了"。
- 前端 `auth.js` 没有独立用例（登录卡片行为由 `main.test.js` / `transport.test.js` 间接覆盖）；
  这是覆盖缺口，不是本轮新引入的失败。
- 一进程 N 租户、OS 级隔离、租户级配额/KMS 仍明确不做（ADR-0004）。
- `saga.sqlite` 仍不按租户分库；同部署根两租户只 `warn`，不阻断（部署纪律见 `docs/tenant.md`）。
