# 策略外置 · S1 施工与对抗式复审

- 施工范围：`01-策略语言与编译器.md`（PE-10 … PE-19）
- 施工时间：2026-10-28
- 输入 HEAD：`c15fb28`（实体槽位 S2 已落库，工作区干净）
- 交付 HEAD：本批提交（S1 一个绿 checkpoint）
- 负控证据：`s1-negative-controls.log`（24/24 PASS）

---

## 1. 交付物

| 类别 | 内容 |
|---|---|
| 代码 | `packages/policy/`（14 个源文件 + 6 个测试文件）：词法/语法/类型/求值、决策表、静态分析、规范化 IR、摘要、语料、变异、签名、载入 |
| 数据 | `policies/bank-tier/1.0.0/`：`bundle.yml` / `rules.yml` / `corpus.yml`（20 例）/ `CHANGELOG.md` / `lock.json` |
| CLI | `policy:lint` / `policy:compile --write|--check` / `policy:test` |
| 工程登记 | `tsconfig.host|json|scripts`、`vitest.shared.ts`、覆盖率名单（`policy` 全包 100%）、barrel 名单、`verify-package-graph`（加入域层）、`package.json` scripts |
| 事实面 | `facts.md` / `facts-sources.md` / README / testing / deploy / security-self-assessment：213 文件 / 2329 例 |

**判据实测**（01 §14）：

| 判据 | 结果 |
|---|---|
| `packages/policy/src/**` 逐文件 100% 行/语句/函数覆盖 | ✔ 全部 100%；分支最低 80.0%（`yaml.ts`），其余 90%+ |
| `pnpm policy:lint policies/bank-tier/1.0.0` | ✔ 通过，0 告警 |
| `pnpm policy:compile --check` | ✔ lock 一致（CRLF 检出后仍一致） |
| `pnpm policy:test` | ✔ 20 例全绿、规则 5/5、理由 4/4、边界 5/5、变异 16/16 killed（100%） |
| 错误码全部有单测 | ✔ `error-matrix.test.ts` 机械自检：27 个错误码 + 1 个告警，触发集合与码表**完全相等** |
| `pnpm typecheck` | ✔ 三项全绿 |
| `packages/policy` 不依赖 runtime/bank/host | ✔ 只依赖 `@bah/util` + `yaml` |
| 语义摘要对注释/缩进/键序/CRLF 不变 | ✔ 注释+CRLF、reasons 顺序两种 fixture 均不变；源摘要变 |

`pnpm gate` **36/36**（无新增门禁，4 条 `verify-policy-*` 属 S4）；全量 `vitest` **213 文件 / 2329 例**全绿。

---

## 2. A 角度：验收与契约

| # | 结论 | 证据 / 说明 |
|---|---|---|
| A-01 | 通过 | 规则文件化：`policies/bank-tier/1.0.0/rules.yml` 5 行规则，编译后 IR 与 `tier.ts` 语义逐条对应（01 §11.3 映射表） |
| A-02 | 通过 | 载入即校验：`compileBundle` 全部前置检查；坏 bundle 无一条能进运行期（负控 1–23） |
| A-03 | 通过 | 版本身份内容寻址：`bank-tier/1.0.0+sha256:97764bc1298834d6`；改一条规则 → 摘要变 |
| A-04 | 通过 | 每条判决有身份的数据基础：`evaluate` 返回 `{level, reason, ruleIds, tables}`；`ruleIds` 含默认行 |
| A-05 | 通过（有边界） | `policy:explain` 未实现（S3/PE-33）：S1 只保证"归档件可复算"所需的 IR + 摘要 |
| A-06 | 通过 | 硬不变量不在 bundle：bundle 内无身份/锁定/预检/生效上限分支；`grep` 规则文件无这些词 |
| A-07 | 通过 | 参数只声明名字/边界，值来自输入；`params` 必须恰好匹配，多传/少传/越界都拒绝 |
| A-08 | 通过 | 金额整数分：词法层拒小数/科学计数；schema 只有 `*Cents` |
| A-09 | 通过 | PII 不进策略：字段表无 `payee.name`/`memo`/租户（`schema.test.ts` 显式断言） |
| A-10 | 通过 | 语言无 I/O/时钟/随机/正则：`matches()`/`now()`/`env.*`/`~=` 全部编译期拒绝 |
| A-11 | 通过（有边界） | CLI 契约只交付 lint/compile/test；`diff/render/sign/install/explain/promote/rollback/versions/audit-verify/shadow` 属 S3/S4，**不宣称"CLI 齐全"** |
| A-12 | 通过 | `1.0.0` 与 legacy 的差异已消除：方案示例 RC-001 缺 `level != "green"`，会让"绿级 + 风险超阈"理由变成 `risky-calls`（legacy 是 `declared`）；本批补守卫并用 C-020 钉住 |
| A-13 | 通过（有登记） | 签名：Ed25519 签"身份"（两摘要 + engine + owners），可验签、可拒错钥/错版本；`bundle.sig` 缺失 + `requireSignature` 拒绝 |
| A-14 | 通过（有登记） | 事实面同批更新（测试数）；**覆盖率台账未更新**，见 §6 P1-1 |

---

## 3. B 角度：对抗与回归

| # | 结论 | 证据 / 说明 |
|---|---|---|
| B-01 | 通过 | 24 条负控全部"应红即红"（`s1-negative-controls.log`），含降级/重复/不可达/恒假/浮点/正则/时钟/路径穿越/超大/坏签名 |
| B-02 | 通过 | 篡改 IR：未知节点/未知运算符/类型混乱 → `policy-eval-invalid`；溢出 → `policy-eval-overflow`；**没有 allow 分支** |
| B-03 | 通过 | 缺字段 → `policy-input-invalid`（fail-closed）；`preview` 缺失时表级 `requires` 整表跳过（不算命中默认行） |
| B-04 | 通过 | 输入深冻结；`compiled.parameters` 也冻结（复审发现的可变暗门，已修） |
| B-05 | 通过 | 复合观察：`bundle.sig` 参与文件遍历但不进源摘要；签名后改 `rules.yml` 一字节 → 源摘要不符优先拒绝 |
| B-06 | 通过 | CRLF 检出：整目录转 CRLF 后 `--check` 仍通过（`normalizeSourceText`），摘要与平台无关 |
| B-07 | 通过 | 并发/确定性：求值纯函数，属性测试两组（10000 次）断言同输入两次全等、级别单调、`reason` 在词表内 |
| B-08 | 通过（有登记） | 每行都有变异体（16/16 killed）；无字面量的 bundle 不生成 `const-offset` 变异（报告为 0，不是静默跳过） |
| B-09 | 通过 | 旧行为零回归：全量 213 文件 / 2329 例绿；未触碰 `bank`/`host`/`runtime` 任何源码 |
| B-10 | 通过 | 依赖方向：`policy → util`；`verify-package-graph` 把 `@bah/policy` 加入域层，反向依赖会被拦 |
| B-11 | 通过 | 覆盖率门禁：`policy` 进名单后逐文件 100%，`verify-coverage-allowlist` 命中 14 个源文件 |
| B-12 | 通过（有登记） | 静态分析 sound 但不 complete：合取矛盾（`p<0 && p>5`）、`a && b` 组合覆盖不判；方案 §7.1 允许 |
| B-13 | 通过（有登记） | 源摘要包含 `CHANGELOG.md`：改文档也要新目录/重签。取舍是 I9 优先，已在 CHANGELOG 写明"不可就地修改" |
| B-14 | 通过 | 事实面：`verify-facts` / `verify-assertions` / `verify-docs-consistency` 全绿 |

---

## 4. 复审发现（按严重度）

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| P0-0 | — | 无 | — |
| P1-1 | P1 | **覆盖率台账滞后**：`docs/coverage-baseline.json` 仍是 91.14%（15/16 包）。`policy` 包进名单后 CI 分母变化，`verify-facts` 在 CI 上会拿新报表比旧台账判红 | 本机 Windows 口径与 CI 不可比（PA-06），**不写本机数**。按仓内先例（`23df3e6`）在 CI 跑批后用实测更新台账 + facts 三处；已在提交说明登记 |
| P2-1 | P2 | 方案 §14 写"错误码矩阵 22 条"，§6.4 实列 24 条，另有 §2.2/§5.3/§5.4 明示 3 条运行期码 + 1 条运算符码 = **28 条** | 实现 28 条并由 `error-matrix.test.ts` 机械自检；方案数字待订正（属文档债，不改行为） |
| P2-2 | P2 | PE-12 要求"可选字段必须 `has()` 守卫"，§5.1 又说"v1 连 `has()` 都不需要" | 采用 §4.1 的**表级 `requires` 守卫**：未声明 `requires` 就引用 `preview.*` → `policy-type-mismatch`（expected=`requires:preview`）。两处文档口径需统一 |
| P2-3 | P2 | §3.1 写"`bundle.yml` 的 `name` 必须等于**上一级**目录名"，与"目录名 = 版本号"自相矛盾 | 实现按布局 `policies/<name>/<version>/`：`name` = 祖父目录名、`version` = 父目录名；负控 18 已验证 |
| P2-4 | P2 | 方案示例 RC-001 缺绿级守卫，与 legacy 在"绿级 + 风险超阈"上不等价 | 已加 `level != "green"`，语料 C-020 钉住；S2 穷举等价前必须保留 |
| P2-5 | P2 | `lock.json` 的逐文件摘要只记录、不参与拒绝（只校验两个总摘要） | 登记：改 `files` 段不影响判定；要防"清单造假"需在 S4 门禁加逐文件比对 |
| P2-6 | P2 | `--write` 不校验"语义变了但版本号没升"（无 registry 可比） | S4 `verify-policy-registry` 的 semver 规则负责；S1 阶段登记 |
| P2-7 | P2 | `assertBundleSize` 统计目录下**全部**文件（含 `lock.json`/`bundle.sig`），方案只说源文件 | 影响仅几 KB 预算；保留（fail-loud 更安全） |
| P3-1 | P3 | 未知 CLI flag 被静默忽略（`--covrage`） | 登记；S4 统一参数校验时收紧 |
| P3-2 | P3 | `policy:test --coverage` 标志未实现（覆盖块总是输出） | 行为等价于"永远 --coverage"；S4 补文档或补开关 |
| P3-3 | P3 | `locIn` 对引号/多行标量的列号是近似值（行号精确） | 已在源码注释登记；错误信息仍含 `file:line` |

---

## 5. 实现期发现并修掉的口径冲突（不是"顺手改"，是判据逼出来的）

1. **`when: true` 是 YAML 布尔**，不是字符串 → 解析层接受 boolean（否则默认行写不出来）；
2. **EBNF 缺 `!`**，但 §5.2 类型表有 → 按 §5.2 实现 `!`，并在注释登记 EBNF 漏写；
3. **`maxStringLength` 必须小于 `maxExprChars`**，否则"字符串超长"分支永远不可达（原 4096/4096）→ 降到 1024；
4. **`check.ts` 里重复的 `env`/`process` 守卫不可达**（parser 已拦）→ 删除，避免"看着有防线、其实测不到"；
5. **`compare` 的 `default` 与 `toBound` 的兜底**在类型上不可达 → 改为显式表/端点归一，或用手工 IR 用例钉住；
6. **`readBundleFiles` 的单文件读取 catch 不可复现** → 删除该分支，让原始错误直接冒（G8：不留不可达防御）。

---

## 6. 结论

- S1 判据（01 §14）**全部满足**，`pnpm gate` 36/36、`pnpm typecheck` 绿、全量 213 文件 / 2329 例绿；
- 负控 24/24 应红即红；错误码矩阵 27+1 由测试机械自检；
- **未闭合 P1 一项**：覆盖率台账需 CI 跑批后更新（本机不可比，写本机数会让 CI 反而红）；
- 未做（属后续阶段，不计入 S1）：`policy:diff/render/sign/install/explain/promote/rollback/versions/audit-verify/shadow`、`registry.json`、`tier/decided` 新字段、链 `policy/decision`、穷举等价（S2/PE-26）、4 条新门禁（S4）。

> 一句话：**规则已经能编译、能求值、能被证明"坏规则进不来"，但还没有接进生产路径**——
> 所以本批只说"编译器完成"，不说"策略已外置"。
