# 贡献指南

感谢你愿意参与 BAH（Banking Agent Harness）。这是一个把"模型能做什么"关进可审计边界里的
银行智能体底座：模型负责理解与表达，能不能执行、执行到什么程度、事后怎么解释，由确定性代码决定。
因此本项目的贡献方式和普通前端/后端仓库不太一样——**可复现的证据优先于漂亮的实现**。

参与即表示你同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)；
安全问题请走 [SECURITY.md](SECURITY.md) 的私密通道，不要开公开 issue。

---

## 1. 环境

| 依赖 | 版本 | 用途 |
|---|---|---|
| Node.js | `^22.19 \|\| >=24`（见 `.nvmrc`） | 全部 JS/TS 面 |
| pnpm | 10.34.7（`corepack enable` 后由 `packageManager` 自动锁定） | 工作区与脚本 |
| Python | 3.11 | 仅知识库 sidecar `services/rag`；不跑 RAG 可不装 |
| Docker | 任意近期版本 | 可选，容器演示与 `docker-compose.yml` |

```bash
corepack enable
pnpm install          # 会自动执行 prepare，把 core.hooksPath 指向 .githooks
pnpm demo:web         # 离线 router，无需任何密钥，打开 http://127.0.0.1:7331
```

主演示**不需要模型密钥**。要接真实模型时，把 `.env.local`（已被 gitignore）里的
`BAH_MODEL_KEY` 填上，并按 `profiles/web/patch.yml` 注释成对切换 provider。

## 2. 提交前自检

三处拦截，力度递减，任意一红都不要推：

| 时机 | 命令 | 说明 |
|---|---|---|
| 提交前 | `pnpm gate` | 静态与契约门禁（由 `.githooks/pre-commit` 自动跑） |
| 推送前 | `pnpm check` | 14 步全链路：类型、lint、构建、单测、覆盖率、门禁、评测、快照、前端、RAG |
| 推送后 | `pnpm check:ci` | 与 CI 一致；严格模式下"未执行"不算通过 |

日常最小回路：

```bash
pnpm typecheck
pnpm test -- <你的测试文件>
pnpm gate
```

第一次跑 `pnpm check` 会比较慢（全量用例 + 覆盖率 + 评测）。**不要用 `--no-verify` 绕过钩子**：
钩子是本地唯一拦截点，绕过等于把回归直接推给 CI。

## 3. 按改动类型决定"还要做什么"

| 你改了什么 | 必须同批完成 |
|---|---|
| 任何行为变化 | 带一条能红的用例；只改实现不带用例的 PR 会被要求补 |
| 用例数量变化 | 同步 `facts.md`、`docs/facts-sources.md`、`README.md`、`docs/deploy.md`、`docs/testing.md`（漏一处 `docs-consistency` 就红） |
| 新增/删除门禁 | 同步 `facts.md` 与 `docs/facts-sources.md`；`verify-facts` 按文件名重算，不认手写数 |
| 改工具契约 / 事件表 / 场景 DSL | 同步 `docs/contracts/*`，契约是冻结面 |
| 改 profile / 装配 / 插件行 | 重录快照（`pnpm snapshot:record`）并跑 `pnpm test:snapshot`；装配变了不重录 = 假绿 |
| 改工具出参 | 同步 `packages/bank/src/tools/result-schemas.ts` 与 `docs/tool-catalog.md`（后者由 `pnpm tool-catalog` 生成） |
| 改 plan 编排状态机 | 同步 `docs/plan.md`；`plan/aborted.reason='halted'` 只允许宿主写 |
| 金额相关 | 一律整数分，禁止浮点与 `Number()` 转换 |

覆盖率口径：全仓行覆盖率与"逐文件 100% 强名单"是两道闸，前者出数字、后者只对名单生效。
名单与取值命令见 [facts.md](facts.md)。

## 4. 提交信息

用 Conventional Commits，描述行为差异而不是"改了哪几个文件"：

```text
feat(web): 增加历史会话列表与追问建议
fix(ci): 修复快照基线解析与覆盖率检查顺序
test(host): 补齐 plan 唤醒环的降级与补偿分支
docs(facts): 用例数按实测更新（四处对齐）
```

scope 用包名或层面（`web` / `host` / `bank` / `plan` / `saga` / `ci` / `docs` / `facts`），
多包用逗号：`feat(web,host): ...`。正文写动机与取舍；已知限制要写出来，不要藏。

## 5. Pull Request

- 一个 PR 只做一件事；重构与行为变更分开提。
- 描述里给出：动机 → 行为差异 → 验证命令与关键输出（`pnpm check` 的汇总行最有用）。
- 改了对外可观察面（事件、工具、路由、配置键）时，在描述里显式列出兼容性影响。
- CI 需要仓库 Secrets 里的 `DEEPSEEK_API_KEY` 才能跑真实模型 e2e。来自 fork 的 PR 拿不到
  该 Secret，e2e 会显式标为 **skipped**（不是通过）；维护者合并前会在主干上复跑一次严格模式。

## 6. 许可与来源

- 本项目以 **Apache-2.0** 发布。**inbound = outbound**：你提交的贡献按同一许可授权，
  无需签署 CLA，但请不要提交你无权授权的代码。
- 不要 vendor、不要复制任何第三方 Harness 的实现；机制层面的参考只能取公开文档描述的设计思想，
  并在 [NOTICE.md](NOTICE.md) 登记"参考了谁、参考到什么粒度"。
- 新增第三方依赖前先确认许可与本项目兼容（Apache-2.0 兼容 MIT / BSD / Apache-2.0；
  GPL / AGPL / SSPL 类需先开 issue 讨论），并在 `NOTICE.md` 逐项登记。
