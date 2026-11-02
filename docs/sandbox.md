# 沙箱（`@bah/safety` 的 sandbox-policy / sandbox-runtime）

> 设计。代码：`packages/safety/src/sandbox-policy/`、`packages/safety/src/sandbox-runtime/`。
> 用例：`policy.test.ts`（22 例，行覆盖 100%，已进强制名单）、`runner.test.ts`（11 例，含 worker 硬杀）。
> 门禁：`pnpm gate` 的 `sandbox` 项。

## 1. 为什么要有一层沙箱

模型可以生成"算一下各分类占比"的程序。程序一旦可执行，就必须回答三个问题：
**在哪跑、能跑多久、能碰什么**。这三件事如果散在工具体里，就没有地方能证明"它碰不到"。

沙箱把这层收在安全平面：`sandbox-policy` 只裁决档位，`sandbox-runtime` 只负责执行与失败上报。
业务包（`@bah/bank`）不决定自己能进哪一档，也不决定自己能跑多久。

## 2. 三档位（§1）

| 档位 | 用途 | 执行位置 | 硬约束 |
|---|---|---|---|
| `query-only` | 只读计算 | 一次性 worker | 2s 时限、64MB 堆、256KB 载荷 |
| `compute-bounded` | 模型写的表达式 / 分析脚本 | 一次性 worker | 5s 时限、128MB 堆、1MB 载荷 |
| `none` | 仓内受信任的确定性代码 | 进程内直调 | 无硬杀、无堆上限——**因此模型代码禁入** |

隔离档位的能力白名单恒为空数组：`network` / `filesystem` / `process` / `external-io` 一律拒绝。
执行体自己在登记表里声明需要什么能力，声明了就走不进隔离档（父侧拒一次、worker 侧再复核一次）。

## 3. 档位解析（按调用，三层覆盖）

```text
默认档（Config 的工具表 + fallbackTier）
  ← 会话 override（只收紧；放宽即抛 override-widens）
  ← 显式批准档（可放宽，上限 compute-bounded；按参数指纹一次性消费，带时效）
```

两条不可配置的恒等规则：

1. `codeSource: 'model'` 解析到 `none` → 抛 `bah-sandbox: model-code-to-none`（§2 硬规则）；
2. 会话 override 只能收紧。想放宽必须有一条人签过的批准，而且批准也买不到 `none`。

批准的一次性核销与票据同构：命中即从表里摘掉，过期条目在解析时清扫，不留无界增长的表。

## 4. 执行与三态失败（§3.1）

| 结局 | 触发 | 上报事件 |
|---|---|---|
| `refused` | 能力被拒 / 载荷超限或不可序列化 / 执行体未登记 | `sandbox/refused` |
| `error` | 程序抛错、worker 崩溃、OOM、模块形状不符 | `sandbox/error` |
| `timeout` | 超过档位时限，父侧 `worker.terminate()` 硬杀 | `sandbox/timeout` |

三类都转成结局（`isError` 的工具结果由宿主组装），**不冒泡到主循环**。每次执行完强制
`terminate()`，worker 不复用；并发上限排队等待（默认 4）。

worker 入口按运行位置解析：调用者是 `.ts` 就用 `src/sandbox-runtime/worker.ts`（带
`--experimental-strip-types`），是 `.js` 就用 `dist/sandbox-runtime/worker.js`。文件不存在即抛
`bah-sandbox: module-missing`——"加载不到沙箱入口"是装配缺陷，绝不降级成进程内执行。

## 5. 受限语言（`sandbox-runtime/language.ts`）

语言的属主在这里，不在业务包：`packages/bank/src/tools/compute.ts` 现在只是把 `@bah/safety`
的语言跑一遍并映射理由码（`program-*` → `compute-*`），工具面口径不变。

语言里**没有**循环、函数定义、模块访问与任何 IO 原语，因此"程序跑多久"由运算预算 + 墙钟
双保险决定，而不是只靠外部杀进程。支持：数字、`+ - * / %`、括号、一元正负、
`data.<path>` / `data['key']` 只读引用、`sum/avg/min/max/round/abs`、常量 `PI`/`E`。

该文件与 `worker.ts`、`handlers/**`、`testing/**` 构成 worker 加载链，受门禁 `sandbox` 约束：
**零包名 import + 可擦除语法**。破坏这条会在生产运行时才暴露（要靠 `dist/`），所以静态挡住。

## 6. 已知边界

- `none` 档没有硬杀：它的存在意义就是"仓内代码进程内直调"，模型代码买不到它。
- 能力剥离是**逻辑隔离**（无 IO 原语 + 能力白名单 + 堆/时限 + 硬杀），不是 OS/容器隔离；
  native addon 加固按§3 明示不在交付主线。
- `maxPayloadBytes` 按序列化后的字符数计，不是 UTF-8 字节数（对 256KB / 1MB 量级的判定足够，
  但别把它当精确计费口径）。
- 演示通道 `analysis_calc` → `compute-bounded` 已由宿主行 `safety:sandbox` 接线
  （`BANK_COMPUTE` 服务键 + 登记表注册 `compute` 执行体，base bundle 默认安装）；
  未装该行的最小装配（单测）回退进程内实现。
