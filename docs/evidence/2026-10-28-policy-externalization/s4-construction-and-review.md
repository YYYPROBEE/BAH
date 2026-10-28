# 策略外置 · S4 施工与对抗式复审

- 施工范围：`03-装配迁移与门禁.md` 的 S4 未完成项（PE-40 … PE-49）
- 施工时间：2026-10-28
- 输入 HEAD：`d2f8922`（S3 运行期平面已落库）
- 上游方案：`BAH-策略外置施工方案-2026-10-28/00-总纲与决策.md`、`03-装配迁移与门禁.md`
- 交付状态：**S4 完成**；`gate 40/40`、`typecheck` 绿、快照 8 文件 / 34 例绿；
  第二轮复审后主仓 219 文件 / 2405 例（见 §6）

---

## 1. 交付物

| 类别 | 内容 |
|---|---|
| 门禁 | `verify-policy-bundle` / `verify-policy-conformance` / `verify-policy-hardcode` / `verify-policy-registry`（36 → 40） |
| 负例 | `policies/fixtures/invalid/**` 27 个，逐条断言错误码；`expected.json` 是清单 |
| 演示 bundle | 新增 `policies/demo/bank-tier-demo/1.1.0`（800 元演示规则 + 11 条语料，21/21 变异）；`1.0.0` 保持原样 |
| 快照 | 新增 `snapshots/policy-externalized`（overlay active=demo/1.1.0，6 例） |
| 银行侧 | `transfers.ts` 试算展示改用 `decide()`（不再直接引用 `escalateTransferTier`，行为等价） |
| 修复 | `analyze.ts` 区间包含方向写反（S1 遗留 bug）；`verify-tiers` 计数器属性误报 |
| 文档 | `docs/policy.md`、README / facts / facts-sources / profile / bank / audit / security-design / deploy / testing / security-self-assessment |

---

## 2. 判据实测

| 判据 | 结果 |
|---|---|
| `pnpm typecheck` | ✔ 三项全绿 |
| `npx vitest run` | ✔ **219 文件 / 2404 例** |
| `pnpm test:snapshot` | ✔ **8 文件 / 34 例** |
| `pnpm gate` | ✔ **40/40**（4 条策略门禁全绿） |
| `verify-policy-bundle` | ✔ 3 个 bundle 编译；27 个负例全部按预期失败 |
| `verify-policy-conformance` | ✔ 生产 1.0.0：20 例、5/5 规则、变异 16/16；demo 1.1.0：11 例、21/21 变异；等价 480 组逐字段 + 480 组未绑定边界 |
| `verify-policy-hardcode` | ✔ 26 个银行源文件 / 16 个策略源文件 / 1 个生产 bundle；IR 无数字常量 |
| `verify-policy-registry` | ✔ 3 个版本目录/摘要/engine/handle；state 不存在；rollout 链不存在 |
| `policy:test` demo 1.1.0 | ✔ 11 例、6/6 规则、4/4 理由、5/5 边界、21/21 变异 |
| `policy-externalized` | ✔ `tier/decided = red + daily-limit + TR-004-single-large + demo/1.1.0`；同一证据输入给 legacy 是 yellow |

---

## 3. A 角度：验收与契约

| # | 结论 | 证据 |
|---|---|---|
| A-01 | 通过 | 4 条门禁按 03 §7 落地；`run-gates` 40 项 |
| A-02 | 通过 | bundle 门禁比**整份** lock（摘要 + 文件清单 + 字节数），不只两个摘要 |
| A-03 | 通过 | 负例覆盖降级/重复/不可达/恒假/缺默认/未知工具/参数/字段/类型/浮点/正则/时钟/理由/拒绝码/动作冲突/参数未用/引擎/语义/目录/路径/缺语料/摘要/三类上限 |
| A-04 | 通过 | 生产 bundle 跑语料 + 覆盖 + 变异 + 960 组等价域 + 属性；demo 只验用例（不是生产真相源） |
| A-05 | 通过 | 新快照证明判决来自外置文件：demo 版本 + TR-004 + red；legacy 对照 yellow；evidence.inputDigest 自洽 |
| A-06 | 通过 | 文档口径：gates 40、快照 8/34、测试 219/2404、工具 16、插件 22；`docs/policy.md` 可独立操作 |
| A-07 | 通过（边界） | 覆盖台账仍是 CI 口径 91.14%，本批新增的是 scripts 与策略数据；CI 下次跑批后按流程刷新 `coverage-baseline.json` |

---

## 4. B 角度：对抗与回归（本次复审发现并已修）

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| B-01 | P0 | `verify-policy-hardcode` 只读 `<dir>/rules.yml`；manifest 的 `rulesFile` 可指向诱饵文件，内联阈值可绕过 | 改为编译后扫描 **IR**：任何 `when` 里的数字字面量即红；负控用坏 IR |
| B-02 | P1 | `analyze.ts` 的区间包含方向写反（`>10` 后接 `>5` 被误判不可达；镜像写法同理） | 修正 `le`/`ge` 方向；新增 4 组反向回归用例；把 `unreachable-row` 负例改成真正的包含关系 |
| B-03 | P1 | `demo: true` 可被任意路径自声明，生产规则可借 demo 跳过覆盖/变异/等价 | registry 门禁要求 demo 必须在 `policies/demo/` 下；生产 profile 的 `active` 不得指向 demo |
| B-04 | P1 | 门禁下限 36 / 负例下限 18：删掉 4 条门禁或 9 个负例仍绿 | 下限改为当前数 40 / 27；删任何一条必须同步改常量 |
| B-05 | P1 | "960 组逐字段等价"口径夸大：实际 480 组已绑定比较 + 480 组未绑定只验 no-identity | 文档统一改成 480 + 480；门禁 note 同步 |
| B-06 | P2 | 快照 T-PE-001 用事件自带 evidence 自证，未校验 `inputDigest` | 断言 `sha256(canonicalJson(input))`；负控仍保留 replay 比对 |
| B-07 | P2 | `transfers.ts` 的 `??` 与旧 `escalateTransferTier` 的 `=== undefined` 语义不完全一致 | 先算 `limitCents`，`decide` 与 DTO 复用同一值 |
| B-08 | P2 | `verify-snapshot-fresh` 的敏感面不含 `packages/policy/src` | 加入；策略编译器改动必须由快照背书 |
| B-09 | P2 | demo 1.0.0 就地改阈值会破坏"已安装版本不可变" | 改为新增 1.1.0；1.0.0 保持原样，registry 同批增加 1.1.0 |

---

## 5. 未做 / 残余风险

- **覆盖率台账**：本批不写本机 Windows 口径；`docs/coverage-baseline.json` 仍是 CI 的
  91.14%，下次 CI 跑批后按 `facts-sources.md` 流程更新。新增 `analyze.ts` 分支与
  `transfers.ts` 行数会改变分母，这是预期的。
- **demo 只验用例**：演示 bundle 不要求覆盖/变异/等价（`demo: true` 且必须在
  `policies/demo/` 下）；真正的生产包（`bank-tier/1.0.0`）全查。
- **试算展示**：`transfer_preview.effectiveTier` 仍是 legacy 展示口径；权威判决只来自治理平面。
- **生产签名**：Ed25519 可选验签已具备，但密钥分发/轮换流程未落地；演示 `unsigned`。
- **semver 差异 major 检查**：当前只有一个生产版本，规则暂为 no-op；新增生产版本时需补。
- **S5 `sentry.rules`**：未做（方案可选阶段）。
- **已提交**：S4 施工 `18984a9`；第二轮复审修复与记录见 §6（本文件同批提交）。

---

## 6. 第二轮独立复审（提交前，2026-10-28）

> 方式：不引用上一轮结论，按 04 §12 的 A/B 清单重新取证；先跑判据，再攻击门禁。

### 6.1 判据复跑

| 判据 | 复跑结果 |
|---|---|
| `pnpm typecheck` | ✔ 三项全绿 |
| `pnpm gate` | ✔ **40/40** |
| `npx vitest run` | ✔ **219 文件 / 2405 例**（复审新增 1 例 min 方向边界） |
| `pnpm test:snapshot` | ✔ **8 文件 / 34 例** |
| `policy:explain`（快照 call-create） | ✔ `reproduced yes`，规则行 `TR-004-single-large (rules.yml:26)` |
| 篡改 evidence 的 explain | ✔ 退出码 1，`input-digest-mismatch` |
| `--require-chain`（快照无链） | ✔ 退出码 1 |
| 归档缺失（registry 指向不存在的目录） | ✔ 退出码 1，`policy-archive-missing` |
| `bench:policy` | ✔ compile 1.700 ms、eval p99 3.700 µs、reload 1.679 ms（均低于预算） |
| 坏 bundle 演练 | ✔ 就地改一字节 → `policy-digest-mismatch`；`raise: purple` → `policy-schema-invalid` |
| `pnpm check`（14 步） | **✘ 第 5 步 `test:coverage` 红**：6 个 host/runtime 文件未达逐文件 100%（详见 §6.4）；1–4 步绿，6–14 步未执行 |

### 6.2 对抗式审查（本轮新增发现）

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| R-01 | **P1** | `verify-policy-registry` 的"生产 profile 不得指向 demo"只用内联正则 `active: { ... }`；把 `active` 写成 block 风格即可绕过。`runtime-state` 的 active/canary/history 也没有 demo 检查 | 改为 `yaml.parse` 解析 `policy:rules` 行；state 三处（active/canary/history）拒绝 demo；门禁内加 block 风格 profile + demo state 两条负控 |
| R-02 | P2 | 04 §2.3 的"core 限额 < config 限额 → 取 core"边界没有用例（现有只覆盖 config 更紧） | `tier.test.ts` 新增 min 方向用例（恰好等于账本上限不升 + 超 1 分升红） |
| R-03 | P3 | `gates.smoke.test.ts` 注释行尾残留 `*` | 修正 |

上一轮 B-01…B-09 的修复逐条复核：IR 扫描、`analyze.ts` 方向、demo 路径、40/27 下限、
480+480 口径、`inputDigest` 断言、`transfers.ts` 语义、snapshot-fresh 面、demo 1.1.0 不可变，
均在工作区代码中成立。

### 6.3 第一性原理审查（"外置"是否真的成立）

| # | 追问 | 结论 | 证据 | 残余 |
|---|---|---|---|---|
| F-01 | 改规则是否真的不用改代码？ | **是（限 DSL 可表达的业务升级）** | demo 1.1.0 只改 `rules.yml`，同一 800 元输入由 yellow 变 red；`policyVersion`/`ruleIds` 落在快照 | 硬不变量（身份/锁定/预检/min/挑战）仍在代码，符合 I4 |
| F-02 | 运行期是否只有一个判决真相源？ | **是** | `engine: bundle` 缺服务 → deny `policy-unavailable`；`escalateTransferTier` 只允许 tier/policy；`decide()` 仅在无 escalation 时走 legacy | `transfer_preview.effectiveTier` 仍是 legacy 展示口径（P2，已在 docs 声明）；它是展示，不是执行判决 |
| F-03 | 证据真的能复现吗？ | **是（按记录版本 + 输入摘要）** | explain 复算 `reproduced yes`；篡改输入 → `input-digest-mismatch`；归档缺失走 `policy-archive-missing` | 身份覆盖规则内容，不覆盖求值器实现；引擎语义变更必须升 `engineVersion` 并重编译，当前靠流程而非门禁 |
| F-04 | 门禁数量是否等于防线？ | **否，先证明"应红即红"** | 27 个负例逐条绑定错误码；4 条门禁各有合成负控；下限钉 40/27 | 门禁不重跑测试；覆盖率台账仍待 CI |
| F-05 | demo 会不会变成生产？ | **不会（门禁层）** | `demo: true` 必须在 `policies/demo/`；profile active 与 runtime-state 的 demo 激活均拒绝 | 本地手工改 state 仍是运维自由度（演练需要），不是提交面 |
| F-06 | 文档是否比实现说得大？ | **没有** | `策略外置.*✅`、`多租户策略`、`tier.ts.*唯一` 三条 grep 断言通过；`docs/policy.md` 明确列出五条不能说 | 对外口径仍需按 §5 的残余风险表述 |
| F-07 | "全量绿"是否名副其实？ | **否（交付判据未闭合）** | `pnpm check` 1–4 步绿、第 5 步 `test:coverage` 红：6 个 host/runtime 文件 97–99%；6–14 步未执行 | 覆盖率债：`policy.ts` 19 行来自 S3，其余为既有；PE-46 仍待 CI |

**结论**：S4 交付的是"文档范围内的策略外置"——业务升级规则文件化、内容寻址、逐判决可解释、
demo 证明判决来自文件。**行为面 P0/P1 = 0**；**交付面 P1 = 1**（`pnpm check` 的覆盖率门禁未闭合），
不修、不把它说成全绿。P2 残余（试算展示、引擎版本回放、semver major 门禁、
覆盖率台账、生产密钥流程）原样保留，不得据此扩大口径。

### 6.4 未闭合（P2 及以后）

- **P1（交付面）**：`pnpm check` 第 5 步覆盖率红，6 个文件未达逐文件 100%：
  `host/boot/plugins/agent.ts`（120-121）、`audit-decisions.ts`（220-223）、
  `bank-tools.ts`（269-270、592-597）、`policy.ts`（252-253、272-285、583-588、873、994-995）、
  `host/boot/runtime-context.ts`（149）、`runtime/agent-loop/agent.ts`（526-527）。
  其中 `policy.ts` 的 19 行来自 S3 新增分支；其余为既有债。PE-46 仍待 CI，未修。
- `transfer_preview.effectiveTier` 的 legacy 展示口径（见 F-02）；
- 引擎实现变更与归档回放的一致性（见 F-03）；
- `docs/coverage-baseline.json` 仍待 CI 跑批；
- 生产 Ed25519 密钥分发/轮换；semver major 差异门禁；S5 `sentry.rules`。
