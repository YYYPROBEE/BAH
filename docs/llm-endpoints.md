# 端点与模型：换模型 = 换配置

> 读者：要换网关 / 换模型的人，以及想确认"这个项目没把端点写死"的评审。
> 结论先行：**端点与模型标识都是配置项**，不是三处分裂的实现。代码里唯一的 URL 字面量是官方缺省端点
> （`packages/llm/src/deepseek/wire.ts` 的 `DEFAULT_BASE_URL`），其余全部来自环境变量或 profile。
> 相关：`docs/model-layer.md`（模型层落地）。

## 1. 四个上下文，四份配置

| 上下文 | 谁在用 | 端点来源 | 缺省值 | 读密钥 |
|---|---|---|---|---|
| 离线（随仓默认） | `pnpm bah`、`pnpm demo:web`、门禁与快照回放 | 不读端点（`core:model` 的 `provider: router`） | 无 | 否 |
| 本地真实模型 | 手动把 `core:model` 切成 `provider: deepseek` 之后 | 环境变量 `DEEPSEEK_BASE_URL`；profile 的 `core:model.baseUrl` 可显式覆盖 | `https://api.deepseek.com` | 是（`apiKeyEnv`，缺省 `DEEPSEEK_API_KEY`） |
| CI live | `pnpm check:ci` 的 `test:e2e` 两条用例 | GitHub 仓库 Variables `DEEPSEEK_BASE_URL` | `https://maas.qianwenaiapi.com/compatible-mode/v1` | 是（无 secret 则整步 SKIP，不算绿） |
| 演示 | `pnpm demo:web` | 同"离线"：什么都不读 | 无 | 否 |

口径校正（2026-11-01 读码，与早期口述不同，以本表为准）：

- 随仓 8 份 profile patch **全部**是 `provider: router`；`provider: deepseek` 只在 4 份里以**注释**形式存在
  （切真实模型的写法见 `profiles/web/patch.yml`）。所以"本地默认打 deepseek"不成立，默认是离线。
- `pnpm eval` **不读端点**（纯离线跑分，grep 无 `DEEPSEEK_`）；CI 的 live 面是 `test:e2e`，不是 eval。
- 端点取值的优先级是 profile 的 `core:model.baseUrl` → `DEEPSEEK_BASE_URL` → `DEFAULT_BASE_URL`
  （见 `packages/llm/src/deepseek/adapter.ts` 构造器），空字符串按"未设置"处理并回落官方端点
  （CI 的注释依赖这条行为）。

## 2. 三条硬规则

1. **端点默认只从 `DEEPSEEK_BASE_URL` 来**：常规换网关只设这一个变量、零改代码。profile 里写 `baseUrl`
   是**显式例外**（优先级更高，只有"这个 profile 永远不打官方端点"时才用），用了就要与同 profile 的
   `apiKeyEnv` 一并对齐并在提交说明里写清理由。代码里除 `DEFAULT_BASE_URL` 外**不得出现字面量 URL**
   （测试里的假端点用 `example.test` 这类保留域名）。
2. **兼容端点必须同时支持 `/chat/completions` 与 `/models`**：本仓用前者跑流式、用后者列模型；
   只实现一半的网关会在 `listModels()` 上暴露，而不是在演示现场。尾斜杠由 `joinUrl` 幂等处理，
   不需要你手工裁剪 `baseUrl`。
3. **换模型按"密钥 → 端点 → 模型标识"三步，不改代码**：
   - `DEEPSEEK_API_KEY`：真实密钥只走环境变量 / CI secret / `.env.local`，永不入库；
   - `DEEPSEEK_BASE_URL`：目标网关的 OpenAI 兼容入口；
   - 模型标识：**运行期**读 profile 的 `core:model.model`（同文件的 `loop.model` 必须同步改，两处成对）；
     **e2e 面**读 `DEEPSEEK_MODEL`。模型不在内置规格表里时，用 `core:model.modelSpec` 就地声明能力位
     （不声明会在 `resolveModel` 上 fail-loud，仍然只是漏了一条配置，不用改代码）。
   也就是说：换**网关**零改代码零改 profile；换**模型**改 profile 两行（是配置，不是代码）。

## 3. 怎么验证"真的没改代码"

前提：该 profile 的 `core:model` 已切成 `provider: deepseek`（写法见 `profiles/web/patch.yml` 的注释块；
router 根本不读端点，所以离线 profile 上做这个验证等于什么都没验）。

```bash
# ① 先证明 profile 没被动过：生效树里 core:model 还是原来那几行
pnpm bah --profile web --dump-config

# ② 再把端点指到本机桩上跑一次（桩只需回一条 SSE：data: {...}\n\ndata: [DONE]\n\n）
DEEPSEEK_BASE_URL=http://127.0.0.1:8899/v1 DEEPSEEK_API_KEY=sk-local pnpm bah --profile web
```

判据（缺一不算过）：

1. ①的输出里 `core:model` 行与你切换前一致，`git diff` 对 `packages/` 与 `profiles/` **为空**；
2. ②的请求真的落在 8899 上（桩日志有 `POST /v1/chat/completions`）——端点来自环境变量，不是代码；
3. 把 `DEEPSEEK_BASE_URL` 换成另一个兼容网关，代码与 profile 一字不改仍能出流式文本，且 `GET /models`
   能列清单（证明规则 2 的两条路径都在）。没有可用网关时，第 3 条由下面那组离线回归兜底。

端点配置本身还有一组**离线**回归：`packages/llm/src/deepseek/endpoints.contract.test.ts` 钉住缺省值、
环境变量覆盖、尾斜杠幂等、非 JSON 错误体四件事（不发真实网络请求，无密钥也能跑）。

## 4. 已知限制

- 离线 `router` 只覆盖演示剧本与门禁快照，**不能**用来判断"换网关后模型能不能干这活"；真实模型需要密钥与外网。
- CI 的 live 用例在无 `DEEPSEEK_API_KEY` 时整步 SKIP：流水线绿**不等于**真实端点验过（`BAH_REQUIRE_E2E=1` 才强制）。
- 非 JSON 错误体（如网关返回 HTML 502 页）目前**已**被归一成 `BahError('llm-http-error')`：状态码在
  `detail.status`、响应体截断到 500 字符放 `detail.body`——可读，但不可结构化解析；要按网关错误码分支，
  需另加映射。
- `GET /models` 只是适配器能力，**boot 不预检端点**：网关"能列模型但流式不可用"这类半残状态，要等到
  `stream()` 首帧才暴露。真实端点可用性目前只有 e2e 两条用例在证。
