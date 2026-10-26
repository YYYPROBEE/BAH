# 交接：W05–W15 已完成，W18 卡在网页审批弹窗

> 2026-10-26 · 会话中途断开后的续跑入口
> 读这一份就能接着干，不需要翻聊天记录。
> 原任务书仍是 docs/next-orders-w05-w20-2026-10-26.md（**它的 §0 状态表已过期，见 §6**）。

## 0. 一句话现状

W05 / W06 / W13 / W14 / W15 五单已实现、已测、已双角度复审并写进 PROGRESS.md §74–§83；
**2026-10-26 又做了一次全量复审（PROGRESS.md §84）**：逐条复算本文所有数字，
三绿全绿（194 文件 / 1949 例，eval 平面 22 文件 / 158 例，门禁 30/30，`tsc -b` 0 错），
并修掉两处复审挖出的真缺陷（`--snapshots` 示例路径不存在 + 文档里的假 flag 名）。
**W18 第一步已收口（2026-10-26）**：阻塞根因**不在 web 接线**，在 `session/event` 的**投递顺序**——
`safety:sentry` 的 `trace.sink=session` 在自己的监听器里再 `appendDomain`，嵌套事件把 seq=N+1
先送给排在它后面的 `WebProjector`，投影器的 `seq <= last` 幂等守卫就把 seq=N 静默丢掉。
已按回归修（广播队列化，一处改动）+ 两条用例（`TC-W18-01` / `TC-W18-02`），并在 Edge 里
**真点了一次批准**（转账成功 ¥800.00）。细节与全部实测数字见 PROGRESS.md §85–§86。
W18 剩余：三段录屏（第 ① 段已具备条件）与 12 页 PPT 文稿。W17 / W19 / W20 未开工。
**工作区全部未提交**（HEAD 仍是 `e8be246`，脏）。

## 1. 长期约束（每单开工先默读一遍）

红线（违反即返工）：

- R-1 不改 `packages/core/src/api.ts` 的契约面；
- R-2 不新增**外部**运行时依赖；内部 `@bah/*` 加边必须过 `scripts/verify-package-graph.ts`；
- R-3 工具执行只走 `new ToolPipeline(...).execute()`，不碰 `definition.execute`；
- R-4 `packages/runtime/src/plan/` 只许 import core / util / 相对路径；
- R-5 新代码里的钱一律整数分或十进制字符串，禁 float、禁 `Number()`、禁 `Math.round(x*100)`；
- 不新增快照场景（`snapshots/` 固定 4 个）；用例 ID 一律 `TC-W##-NN`；
- 新增配置键必须凑齐四件套（白名单 + 默认值 + fail-loud + 文档表格）；
- 新建 `.ts` 必须 `git add`（`scripts/verify-tracked-sources.ts` 会红）；
- 文档里反引号包起来的仓库路径必须存在（`scripts/verify-docs-paths.ts`），
  **规划中/未来的路径放围栏代码块里，不要加行内反引号**；
- `BAH_KNOWLEDGE_KEY` 只从环境变量取，绝不写进 `profiles/*.yml`（那是要入库的）；
  `.secrets/` 已 gitignore；入库的清单用公钥 `demo-key-not-for-prod` 签名；
  `keys/saga-ed25519.pem` 绝不入库；生产必须注入独立密钥并重签；
- 不 push、不 force-push、不 `reset --hard`、不提交可能含密钥的文件——除非用户明确同意。

三绿命令（每单收尾必跑，`NODE_EXTRA_CA_CERTS=` 前缀不能省）：

```bash
NODE_EXTRA_CA_CERTS= npx vitest run
BAH_ALLOW_NO_SNAPSHOT=1 NODE_EXTRA_CA_CERTS= npx tsx scripts/run-gates.ts
NODE_EXTRA_CA_CERTS= npx tsc -b tsconfig.host.json tsconfig.client.json
```

- `BAH_ALLOW_NO_SNAPSHOT=1` 属例外使用，必须在 PROGRESS.md 里写明理由（现登记在 §72.3 第 3 条）；
- 全量测试用后台跑并把输出写到 `.ci-artifacts/`，**绝不并行起两个 vitest**；
- **跑三绿之前先确认 7331 端口是空的**：
  `packages/cli/src/main.smoke.test.ts` 的 W04 TC-08/TC-09 会真起进程 boot `web` profile，
  而 `--dump-config` 是在 `boot()` **之后**才打印的（packages/cli/src/cli/run.ts:192 起），
  web channel 在 boot 期就 `listen(7331)`，且 W16 的设计是"端口占用**不自动换端口**、直接 fail-loud"。
  所以只要有一个演示服务占着 7331，主 vitest 就固定红这 2 例——**这是环境假象，不是产品回归**。
  查占用与清理：

```powershell
Get-NetTCPConnection -LocalPort 7331 -State Listen | Select-Object -ExpandProperty OwningProcess
Stop-Process -Id <那个 PID> -Force
```

- `--profile web` 现在需要 `BAH_KNOWLEDGE_KEY`（`profiles/web/patch.yml` 装了 `bank:knowledge`，
  headless/plan 没装所以不缺）；缺键是 W06 预期的 fail-loud，不是 bug；
- eval 平面跑法（不花钱，用 MockLlmAdapter，零真实模型调用）：

```bash
npx tsx scripts/eval.ts                 # 60 例场景（W13）
npx tsx scripts/eval.ts --adversarial   # 45 例对抗（W14），写全量报告
npx tsx scripts/eval.ts --smoke         # 对抗集每族 3 例（隐含 --adversarial，会覆盖报告）
npx tsx scripts/eval.ts --baseline-check  # 与 packages/eval/baseline.json 比对（CI 用这条）
npx tsx scripts/eval.ts --baseline-record # 重录基线（须在 PROGRESS 记原因）
npx tsx scripts/replay.ts --session <id> --dir <jsonlDir> --verify
```

- 真实 flag 名是 `--baseline-check` / `--baseline-record`，**没有 `--baseline`**：
  敲 `--baseline` 会被静默当成"跑普通场景"，不报错也不比基线（复审时发现的第一个坑）；
- `--smoke` 会把 `.ci-artifacts/eval/adversarial-report.json` 覆盖成 9 例版本，
  所以**全量 `--adversarial` 要放在最后一个跑**，否则 41/44 的证据被冒烟报告顶掉。

## 2. 已完成五单的回执（细节在 PROGRESS.md §74–§83，这里只给指针）

### W05 回复侧事实核验（§74–§75）

- 新接缝 **`agent/reply`**（waterfall），出口 `dispatchReply()` 在 packages/runtime/src/agent/index.ts；
  调用点在 packages/runtime/src/agent-loop/agent.ts 的 `appendAssistantMessage()`——
  **在 `session.append('assistant/message')` 之前**改写，失败闭环保底 `【拒答】…（reasonCode: reply-hook-failed）`；
- 归一化 + 抽取 + 三态（verified / needs-evidence / reject）在 packages/safety/src/verify/ 下；
  未核实前缀 `【未核实】`；会话事件 `safety/assertion` 记四项自洽计数；
- 装配：packages/host/src/boot/plugins/verify.ts（配置 `{enabled:boolean=true}`）
  + `packages/cli/bundles/base/index.ts` 的 `{ id: 'safety:verify' }`；**HOST_PLUGINS 19→20**；
- 踩过的坑：`packages/runtime/src/session/derive.ts` 缺 `case 'safety/assertion': return []`
  → 第二轮 `session-unprojected-event`。新平台事件一定要同步 derive 的 switch。

### W06 知识签名（§76–§77）

- HMAC-SHA256 双层（文件级 + 条目级）在 packages/knowledge/src/sign.ts；
  校验端口在 packages/knowledge/src/verify-port.ts，拒答复用 `knowledge/answered` 信封；
- 夹具：`packages/knowledge/fixtures/corpus.json`（10 篇，切片 id 21–30）
  + `packages/knowledge/fixtures/knowledge.manifest.json`（2 文件 11 条目，`keyId=kid-82d6dbbf47e2`）；
- 签名/校验脚本 scripts/sign-knowledge.ts（`--check` 是 CI 用的，`--from-sqlite` 走 `node:sqlite`）；
- 配置键 `signature:{enabled,manifestPath,corpusPath}` 在 packages/host/src/boot/plugins/knowledge.ts；
- `vitest.config.ts` 注入 `BAH_KNOWLEDGE_KEY=demo-key-not-for-prod`，
  `.github/workflows/ci.yml` 同步加 env 与 `pnpm knowledge:sign --check` 步骤；
- 已知未闭合：HP-2 响应信封仍未签名，安全自评里写的是"部分闭合"，不是"已闭合"。

### W13 场景评测平面（§78–§79）

- 引擎：packages/eval/src/scenario/runner.ts。按 `family:approval:profile:k|n` 分组复用 boot，
  **60 例只 boot 8 次**；确定性时钟 `1_700_000_000_000` 步进 1；seed `20261026`；
  `MockLlmAdapter` 伪装成 `router`/`router-chat`；临时目录 + 5 s 软超时；
  失败码 `assertion-failed|tool-error|scenario-timeout|upstream-unavailable`；
- 总线观察者必须 `return next(payload)`——waterfall 里不调 `next()` 就是短路，
  曾经把 `saga/comp-decided` 悄悄吃掉，报 `Cannot read properties of undefined (reading 'decide')`；
- 波次：非 S/D 并发 → S 单跑 → D 单跑（D 组要抬 `guard.maxToolsPerTurn:1000`）；
- K 族的健康检查超时 5000 ms（分片并发下 2 s 不够）；
- 失败注入缝：`SAGA_BRIDGE_RECIPES` 从 packages/host/src/boot/plugins/index.ts 导出。

### W14 对抗 45 例（§80–§81）

- packages/eval/src/adversarial/ 下 `expected.ts`（45 条元数据 + `validateAdversarial`）
  与三族目录；报告对象 `AdversarialReport{cases,families,overall,unverified,bootCount,smoke}`；
- 期望全部按代码真相写死，不按想象写。已纠正过的想象：
  sentry 的拒绝码是 `sentry-rule-hit`（不是 `PRV-002`）；`daily-limit-exceeded` 是**告警后升红**，
  不是 pre-execute 直接拒；base64 解码有最小长度阈值；`NET-002` 的 `\b` 在中文动词前永不匹配；
  PRV-001 只匹配一种词序；`所有…导出` 里 payload 顺序有意义；
- `buildGroups` 曾按 ID 排序，把 I-15 排到 3 次 P0 命中之后触发 HALT → 现在保留输入顺序；
- 越权族判据是"拒绝 **且无资金动作**"（`isError` 或 deny + 无 `transfer/created` + 余额未变），
  强验证 provider 目前仍是 mock，写"强验证失败所以拦住"会假绿；
- `[unverified]` 样本不进分母（所以分母 44 不是 45）。

### W15 独立重放 + 监管材料 + 基线 + CI（§82–§83）

- 重放在 packages/persistence/src/replay/index.ts 的 `replaySession()`，
  硬判据只有三条：链连续 + 序号连续 + 原始行与读取器等价；
  `tool/call` 与 `approval/decided` 的摘要交叉核对是 **warning**（PII 写入时已脱敏，天然不等），
  所以正常会话 `diff=0`；
- 删中间一行链 → `brokenAt=3`（第一个前驱不匹配的行），不是 2；
- CLI：packages/cli/src/cli/audit-replay.ts，`audit` 子命令里用 `argv[0] === 'replay'` 分派；
  日常优先用 scripts/replay.ts，CLI 面只在必要时铺；
- 监管包：packages/eval/src/evidence/SessionEvidencePack.ts（`session-evidence.v1`，
  三件套 + manifest 的 sha256/bytes/count；计数口径是 `| ` 开头的行减 1，因为 markdown 有表头）；
- Merkle：packages/eval/src/snapshot/merkle.ts + `SnapshotChain.sampleInclusionProofs(0.1)`；
- 基线：packages/eval/baseline.json，比较口径"率降 >5pp 即红 / 平均步数超 5% 即红 / 分母缩小即红"；
  **它录于脏工作区**，`commit` 字段是 `e8be246…`（HEAD），须在提交后重录一次并在 notes 记原因；
- 隔离门禁：scripts/verify-replay-isolation.ts 走"值 import 的传递闭包"，
  白名单是 `@bah/persistence` / `@bah/util` / `@bah/eval` 的**子路径** + `node:*`；
  **`@bah/eval` 根入口单独硬禁**（它会把 runner→host 拖进来），证据包与 Merkle 一律相对路径引用；
  入口可用 `--entry <file>` 或 `BAH_REPLAY_ENTRY` 覆盖（默认 `scripts/replay.ts`）；由 `run-gates` 自动发现，**门禁 29→30**；
- CI：scripts/ci.ts 增 `eval:unit` / `eval:smoke` / `eval:baseline` 三步；
  `vitest.eval.config.ts` 是"133 例"这个假数字的解药——eval 的 `tests/` 不在主 config 的 include 里，
  **实测 155 例**（复审补 3 例后 158）；主 `vitest.config.ts` 的 include 一律没动（那是 W17 的地盘）。

## 3. 必须保持的基线数字（跑出来低于这些就是回归）

| 项 | 值（2026-10-26 复审实测） |
|---|---|
| 主 vitest | 194 文件 / **1951** 例（起点 1899；W18 广播重入修复 +2） |
| 门禁 | **30/30**（起点 29） |
| `tsc -b` host+client | 0 错 |
| 快照回归 | 18/18 |
| eval 平面用例数 | **158**（复审前 155；`npx vitest list --config vitest.eval.config.ts \| grep -c " > "`） |
| eval 场景 | 60/60 通过，`bootCount=8`，墙钟 **6.3 s**（历史 7.489 s） |
| 对抗 | 41/44 = 93.2%（注入 14/14、越权 15/15、幻觉 12/15）；smoke 9/9，墙钟 **2.6 s**（历史 4.347 s） |
| 基线检查 | `--baseline-check` 绿（taskSuccess 49/49、privilegeBlock 5/5、refusalAccuracy 6/6、averageSteps 1.25 ≤ 上限 1.31） |
| 独立重放（真实 web 会话） | `replay session=s-w18-web2 events=105 decisions=10 tickets=2 chain=ok seq=ok diff=0`；证据包离线校验通过；Merkle 抽样 4/33 全过 |
| 冻结计数 | 银行域事件 **19 键**（`BANK_SESSION_EVENT_TYPES`）/ runtime 会话事件 18 键（含 `safety/assertion`）/ 工具 16 / plan 9 态 / saga 11 / HOST_PLUGINS 20 / 门禁 30 |

## 4. W18 阻塞点（新会话的第一个技术动作）

> **状态：已定位并修复（2026-10-26）。** 根因在 `session/event` 的投递顺序，不在 `web.ts` 的接线；
> 修法与实测见 PROGRESS.md §85，双角度复审见 §86。下面 4.1–4.3 保留为**现场记录**（复现步骤仍可跑，
> 但修好之后 `tool` / `approval` 帧会正常出现）。

### 4.1 现象

网页端能收到会话进行中的帧，但**没有 `tool`、也没有 `approval`**，因此审批弹窗（`批准执行` 按钮）永不出现，
最后超时成 `未执行：approval-timeout`。

已排除的假设（都有实测支撑，别重复验证）：

1. **不是事件没产生**。会话 JSONL 里 `approval/asked` 在 seq 29 与 seq 81 都存在，`ticket/issued` 也在；
2. **不是 SSE 链路断了**。页面确实收到了后续的 `approval-closed`（`未执行：approval-timeout`），
   说明活帧能推到浏览器；
3. **不是前端抛异常**。CDP 的 `Runtime.exceptionThrown` 与 `Log.entryAdded` 全空；
4. **不是投影器逻辑错**。独立复现脚本（临时放在 `/tmp/projdebug.ts`，仓库内未保存）
   喂给它合成的 `turn/start → step/start → tool/call → tool/result → approval/asked`，
   `WebProjector.apply` 正确产出 `tool:c1` 与 `approval:c1`，`snapshot()` 里两个都在：

   ```
   tool/call        [ 'tool:c1', 'dag:undefined' ]
   approval/asked   [ 'approval:c1', 'audit:undefined' ]
   snapshot kinds   [ 'turn:undefined','dag:undefined','tool:c1','audit:undefined','approval:c1','audit:undefined' ]
   ```

5. **抓到的帧普查**（`timeout 2 curl -sN "http://127.0.0.1:7331/api/events?token=w18token&since=0"`）：
   `maxSeq 84`、32 帧、`Counter({'audit': 28, 'dag': 2, 'message': 2})` — 缺 `tool` 与 `approval`。

结论：分歧在**运行中的服务里投影器的接线/实例**，不在 packages/channels/src/web/project.ts 的纯逻辑。
查的顺序：packages/host/src/boot/plugins/web.ts（单个 `projector` 被 hub 与 `session/event` 监听共用）
→ packages/host/src/boot/plugins/web/dispatch.ts → packages/host/src/boot/plugins/web/sse.ts
→ `/api/history` 与快照拼装路径。重点看：投影器是不是有两个实例（写入的那个与快照读的那个不是同一个）、
`session/event` 监听是不是只订阅了部分类型、或者快照拼装按 kind 过滤时把 `tool`/`approval` 丢了。

**如果确认是真实产品缺陷，就按 W18 的回归修**（不许为了让视频录出来而改评测口径）。

### 4.2 复现步骤

```bash
BAH_WEB_TOKEN=w18token BAH_KNOWLEDGE_KEY=demo-key-not-for-prod \
npx tsx packages/cli/src/main.ts --profile web --serve \
  --patch .tmp-w18/web-overlay.yml --session s-w18-web2 --jsonl .tmp-w18/web-run2
```

- `.tmp-w18/web-overlay.yml` 把模型换成 `core:model` router、通道换成 `core:agent` web，
  这样**不需要模型 key** 也能跑（零花钱）；
- Edge 起 CDP：`--remote-debugging-port=9224 --user-data-dir=.../edge-profile2 http://127.0.0.1:7331/?token=w18token`；
- 用 Node 连 CDP 操作页面（`.tmp-w18/` 下有 `approve2.mjs` / `approve3.mjs` / `debug-ui.mjs` 三个草稿）：
  填 `.composer__input` → `requestSubmit()` → 轮询 `批准执行` 按钮（轮 20–30 s 全 0）。

### 4.3 现场遗留（务必清理）

| 项 | 值 / 处置 |
|---|---|
| Web 服务 | 复审时**已停**（原 PID 27604）；7331 现在是空的，照 §4.2 重新起即可复现 |
| Edge CDP | 仍在监听 127.0.0.1:9224，PID **23660**（不占 7331，留着可继续用） |
| 会话实物 | `.tmp-w18/web-run2/s-w18-web2/session.jsonl`（105 事件）+ 同目录 `audit.jsonl`（10 判决、2 票据）仍在，**可直接拿来做 W15/W18 的真实证据** |
| 草稿目录 | `.tmp-w18/` 含 overlay、日志、jsonl、sse 抓取与三个 mjs，**绝不入库**，收尾删掉 |
| 端口占用教训 | `taskkill //PID <bash 的 pid>` 杀不掉 Node 子进程；要用 `Get-NetTCPConnection -LocalPort 7331` 找真 PID |

## 5. 剩余单子与其出口

顺序：**W18 → W17 → W19 → W20**（W17 是唯一可能被砍的一单，材料线不能砍；W20 不能提前开工）。

- **W18 视频 + PPT**：三段 ≤3 分钟。① `profiles/web` 真人点批准 60–75 s；② `npx tsx scripts/demo-plan.ts`
  三场景 50–60 s；③ dry-run 证明 `tool/call = 0` 20–30 s。写 docs/demo/ 下的讲稿与 12 页 PPT 文稿
  （每页：主张 + 证据 + 一条取数命令；另加"未实现清单"≥5 条）。
  产出 `交付物/答辩-v1.pptx` 与 `交付物/demo-v1.mp4`，**两者都要加进 `.gitignore`**。
  所有数字必须逐字抄自 `.ci-artifacts/eval/summary.md`，不许手填。
  本机工具链：系统 `ffmpeg` 不可用（WinGet 那个 link 是 0 字节），已 pip 装 `imageio-ffmpeg`
  （可执行文件在 `.../imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe`）与 `python-pptx`；
  有 PowerPoint、有 Edge、无 OBS。录屏靠 CDP 截 Edge 或 PowerPoint 导出。
- **W17 覆盖率**：行覆盖 53.1% → ≥80%，包覆盖 11/16 → ≥14/16；
  新门禁 `verify-assertions` / `verify-no-focused-tests` / `verify-eval-scenarios`；
  `noUncheckedIndexedAccess` 收尾。**动主 `vitest.config.ts` 的 include 会影响覆盖率分母，属本单地盘。**
- **W19 架构图 + 算法 + 安全设计**：mermaid/png 生成的架构面、关键算法叙述面、安全设计面（引用 W14 的来源列）。
- **W20 答辩演练**：5 个演示脚本 + 6 命令矩阵 + 排练记录 + 100 问 Q&A + 评委走查 + 12 点终检。

## 6. 收尾清单（别忘了）

1. ~~`docs/next-orders-w05-w20-2026-10-26.md` 的 §0 状态表还把 W05–W15 列为未完成~~
   复审时已更新为"已完成 16 单 / 未完成 3 单 + 新基线数字"；
2. 提交后重录 `packages/eval/baseline.json`（当前 `commit` 指向脏 HEAD `e8be246…`），notes 里记原因；
3. 删除 `.tmp-w18/`、关掉还挂着的 Edge CDP（PID 23660 / 9224）；
4. `交付物/` 与视频、pptx 一律不进 git；
5. 每单收尾：三绿 + PROGRESS.md 新章节（回执 + 双角度复审两段），
   视角 A 查"验收与契约"、视角 B 查"对抗与回归"，复审发现的问题要当场修并记进偏差表。

## 7. 2026-10-26 复审改了什么（PROGRESS.md §84 的落地面）

复审的动作是"把本文每个断言拿去对着仓库复算"，结果是**四条断言不成立或不准**，全部当场修：

| # | 复审发现 | 定性 | 处置 |
|---|---|---|---|
| 1 | 主 vitest 复跑红 2 例（W04 TC-08/TC-09） | **环境假象**：我自己留下的 web 演示服务占着 7331，而 `--dump-config` 在 `boot()` 之后才打印，web channel 在 boot 期就 listen | 停掉服务后 194/1949 全绿；把"先查端口"写进 §1，附 PowerShell 查占用命令 |
| 2 | `scripts/replay.ts --snapshots` 的示例文件 `session.snapshots.json` **在仓库里不存在**，评委照着敲得到 ENOENT 栈；该分支此前**零测试覆盖** | **真缺陷**（W15 出口 2 的命令行面） | 改成 `.jsonl` 每行一个叶子 / `.json` 取数组或 `snapshots` 字段，形状不符与缺文件都 fail-loud 说清；示例路径换成真实存在的 `snapshots/headless-basic/session.jsonl`；补 `TC-W15-11` 三条用例（真文件 exit 0 / 缺文件 exit 1 / 形状不符 exit 1），eval 平面 155→**158** |
| 3 | 本文给的 `npx tsx scripts/eval.ts --baseline` **不是真实 flag**（真相是 `--baseline-check` / `--baseline-record`），敲错的会静默跑成普通场景 | 文档缺陷 | §1 命令块改正，并把"没有 `--baseline`"写成显式提醒；`--smoke` 覆盖全量报告的坑一并记进 |
| 4 | 本文写 `keys/saga-ed25119.pem`，仓库真相是 `keys/saga-ed25519.pem` | 拼写缺陷（`docs-paths` 门禁扫不到 `keys/`，靠人眼） | 已改正 |

顺带做的一处诚实性改进：门禁 `replay-isolation` 的输出原来打印"允许 @bah/persistence / @bah/eval / @bah/util"，
但它对 `@bah/eval` **根入口**是硬禁的，只放子路径——输出与行为不一致会被评委当成自相矛盾，
note 已改为"（@bah/eval 只许子路径，根入口禁止）"。

复算通过的（不用重查）：PROGRESS §74–§83 章节号与五单对应关系、HOST_PLUGINS=20（含 `safety:verify`）、
银行域事件 19 键、工具 16 个、快照面 4 个场景目录（`vitest.snapshot.config.ts` 5 文件 / 18 例）、`--adversarial`/`--smoke` flag 真实存在、
`SAGA_BRIDGE_RECIPES` 从 packages/host/src/boot/plugins/index.ts 导出、
`snapshot-fresh` 的 `BAH_ALLOW_NO_SNAPSHOT=1` 例外已登记在 PROGRESS §72.3、
eval 60/60 与对抗 41/44 与基线 check 全部**重跑复现**（墙钟 6.3 s / 2.6 s）。

新增的正面证据（可直接进 W18 讲稿与 W20 问答）：对**真实 web 会话** `s-w18-web2` 独立重放得到
`events=105 decisions=10 tickets=2 chain=ok seq=ok diff=0`，同会话的证据包三件套 + manifest
离线校验通过，快照 jsonl 的 Merkle 抽样 4/33 条证明全部离线可验。

## 8. 给下一个 AI 的第一句话（复制即用）

下面这段贴进新会话即可——它是"入口 + 第一个动作 + 红线"，不含背景故事。
注意：块内路径一律不加行内反引号，免得 `docs-paths` 门禁把规划路径算成失效引用。

```text
仓库：D:/项目集/微众杯银行ai智能体/BAH/MonoRepo（Windows + Git Bash + pnpm workspace）
先读 docs/handoff-2026-10-26-w18-blocked.md，它是唯一入口，读完直接开工，不要从头读全仓。

目标：完成剩下的 W18 → W17 → W19 → W20（W17 是唯一可能被砍的一单，材料线不能砍；W20 不能提前开工）。
每单完成后做一次双角度复审（视角 A 验收与契约、视角 B 对抗与回归），并在 PROGRESS.md 追加回执 + 复审两节。

不要重做已完成的部分：W05、W06、W13、W14、W15 已收口（PROGRESS.md §74–§84），
数字已经全量复算过：主 194 文件 / 1949 例、门禁 30/30、tsc -b 0 错、eval 平面 22 文件 / 158 例、
快照 18、web 55、eval 场景 60/60（boot 8 次、墙钟 6.3 s）、对抗 41/44 = 93.2%、基线 check 绿。

第一件事（W18 的阻塞）：profiles/web 的 SSE 里没有 tool 与 approval 两类帧，审批弹窗不出现，
所以"真人点批准"那一段录不出来。已排除的假设（别重复验证）：
事件没产生 —— 会话 jsonl 里 approval/asked 在 seq 29 与 81 都存在，ticket/issued 也在；
SSE 断了 —— 页面收到过 approval-closed（未执行：approval-timeout）；
前端抛异常 —— CDP 的 Runtime.exceptionThrown 与 Log.entryAdded 全空；
WebProjector 逻辑错 —— 独立复现喂合成事件，能正确产出 tool:c1 与 approval:c1 并出现在 snapshot() 里。
要查的是运行中服务里的接线：packages/host/src/boot/plugins/web.ts（projector 实例与 session/event 监听）、
packages/host/src/boot/plugins/web/dispatch.ts、packages/host/src/boot/plugins/web/sse.ts、/api/history 快照拼装。
判据：确认是产品缺陷就按 W18 的回归修；不许为了让视频录出来而改期望值或改评测口径。

开工前置检查（不全绿就别改代码）：
1) 7331 必须是空端口，否则主 vitest 固定红 2 例（W04 TC-08/09 会真起进程 boot web profile，
   而 --dump-config 在 boot() 之后才打印，web channel 在 boot 期就 listen；不换端口 fail-loud 是 W16 的刻意设计）：
   powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 7331 -State Listen"
2) NODE_EXTRA_CA_CERTS= npx vitest run
3) BAH_ALLOW_NO_SNAPSHOT=1 NODE_EXTRA_CA_CERTS= npx tsx scripts/run-gates.ts
4) NODE_EXTRA_CA_CERTS= npx tsc -b tsconfig.host.json tsconfig.client.json

红线：不改 packages/core/src/api.ts 的契约面；不新增外部运行时依赖，内部 @bah/* 加边要过 package-graph 门禁；
工具执行只走 new ToolPipeline(...).execute()；packages/runtime/src/plan/ 只许 import core/util/相对路径；
钱一律整数分或十进制字符串，禁 float / Number() / Math.round(x*100)；不新增快照场景（snapshots/ 固定 4 个）；
用例 ID 必须是 TC-W##-NN；新建 .ts 要 git add；文档行内反引号里的仓库路径必须真实存在，
规划中的路径写进围栏代码块；配置键要凑齐白名单 + 默认值 + fail-loud + 文档表格四件套；
BAH_KNOWLEDGE_KEY 只从环境变量取（profiles/*.yml 是要入库的，绝不写密钥），
keys/saga-ed25519.pem 与 .secrets/ 绝不入库；eval 平面用 MockLlmAdapter，零真实模型调用、零花钱。

工作方式：一次只改一处就验证一次；全量测试放后台跑并把输出写进 .ci-artifacts/，绝不并行起两个 vitest；
文档里写出来的每条命令都要有用例替它站着（TC-W15-11 就是这么补上的）；
汇报只说实测结果——红就报红，环境假象要说明是环境假象，不要把停摆说成正常机制。

现场遗留：.tmp-w18/ 是 W18 草稿目录（已被 .gitignore 的 .tmp-* 覆盖，不要入库，W18 收尾时删）；
Edge 还挂在 CDP 9224（PID 23660，不占 7331，可继续用）；7331 上的演示服务已停，
按本文 §4.2 的命令可重启复现。W18 三段里只有第 ① 段被阻塞，第 ② 段（npx tsx scripts/demo-plan.ts）
与第 ③ 段（dry-run 证据）现在就能录，第 ③ 段的现成证据是：
replay session=s-w18-web2 events=105 decisions=10 tickets=2 chain=ok seq=ok diff=0，
证据包三件套 + manifest 离线校验通过，Merkle 抽样 4/33 全部离线可验。

不要提交、不要 push、不要 force-push、不要 reset --hard、不要丢弃工作区已有改动；要提交先问我。
工作区现在是脏的（HEAD e8be246，270 余项未提交，W05–W15 的新文件已 git add）。
```

念给下一个 AI 的三句口头补充（文档里查不到、但会决定它白干）：

1. **"先查盘再开口"**——它报的每个数字必须来自它自己刚跑出来的输出，不许引用本文的叙述当证据；
2. **"7331 是测试的敌人"**——boot 期就 listen 是刻意设计，不要为了让测试好跑改成懒监听；
3. 需要重录 `packages/eval/baseline.json` 的时机是**提交之后**（现在 `commit` 字段指向脏 HEAD）。

